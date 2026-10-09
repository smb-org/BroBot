import { useCallback, useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { PanelChannelControl, PanelChannelControls } from "../panel-contract";
import type { RealtimeEnvelope, RealtimeEventLogHint, RealtimeMessage } from "../realtime-contract";
import type { AdsSchedule } from "../modules/ads/contracts";
import { REALTIME_PROTOCOL, isPanelModuleRealtimeMessageType } from "../realtime-contract";
import {
  invalidateDashboardChannelQueries,
  invalidateDashboardRealtimeMessage,
  setDashboardRealtimeStatus,
  useDashboardRealtimeStatus,
} from "./data/realtime";

const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type RealtimeFeedStatus = "connecting" | "connected" | "reconnecting" | "offline" | "renew";

export interface RealtimeFeedState {
  status: RealtimeFeedStatus;
  jumpToBeginning: () => void;
}

type RealtimeParseResult =
  | { kind: "foreign-channel" }
  | { kind: "ignored" }
  | { kind: "message"; message: RealtimeMessage };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHint = (value: unknown): value is RealtimeEventLogHint => {
  if (!isRecord(value)) return false;
  return typeof value.eventId === "string" && value.eventId.length > 0 &&
    typeof value.createdAt === "string" && value.createdAt.length > 0 &&
    typeof value.moduleId === "string" && value.moduleId.length > 0 &&
    typeof value.code === "string" && value.code.length > 0 &&
    (value.actorUserId === null || typeof value.actorUserId === "string");
};

const isAdSchedule = (value: unknown): value is AdsSchedule => isRecord(value) &&
  (value.nextAdAt === null || typeof value.nextAdAt === "string") &&
  (value.duration === null || typeof value.duration === "number") &&
  (value.lastAdAt === null || typeof value.lastAdAt === "string") &&
  (value.prerollFreeTime === null || typeof value.prerollFreeTime === "number") &&
  (value.snoozeCount === null || typeof value.snoozeCount === "number") &&
  (value.snoozeRefreshAt === null || typeof value.snoozeRefreshAt === "string");

const isPanelChannelControl = (value: unknown): value is PanelChannelControl =>
  isRecord(value) && typeof value.active === "boolean" &&
  (value.pending === undefined || typeof value.pending === "boolean") &&
  (value.until === null || typeof value.until === "string") &&
  (value.mode === null || value.mode === "timed" || value.mode === "until_stream_end" || value.mode === "unlimited");

const isPanelChannelControls = (value: unknown): value is PanelChannelControls =>
  isRecord(value) && isPanelChannelControl(value.mute) && isPanelChannelControl(value.pause);

const isVariablesChangedPayload = (value: unknown): boolean => isRecord(value) &&
  Array.isArray(value.set) && value.set.every((entry) => isRecord(entry) &&
    typeof entry.name === "string" && entry.name.length > 0 &&
    typeof entry.value === "number" && Number.isSafeInteger(entry.value)) &&
  Array.isArray(value.removed) && value.removed.every((name) => typeof name === "string" && name.length > 0);

const isKnownEnvelope = (value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1;
  id: string;
  createdAt: string;
  channelId: string;
  type: RealtimeMessage["type"];
  payload: unknown;
} => value.version === 1 &&
  typeof value.id === "string" && value.id.length > 0 &&
  typeof value.createdAt === "string" && value.createdAt.length > 0 &&
  typeof value.channelId === "string" && value.channelId.length > 0 &&
  (value.type === "system.hello" || value.type === "event_log.new" ||
    value.type === "variables.changed" || value.type === "overlay.changed" ||
    value.type === "ads.schedule.updated" || value.type === "stream.state.changed" ||
    typeof value.type === "string" && isPanelModuleRealtimeMessageType(value.type));

export const parseRealtimeMessage = (raw: string, channelId: string): RealtimeParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "ignored" };
  }
  if (!isRecord(parsed)) return { kind: "ignored" };
  if (typeof parsed.channelId === "string" && parsed.channelId !== channelId) {
    return { kind: "foreign-channel" };
  }
  if (!isKnownEnvelope(parsed)) return { kind: "ignored" };
  if (isPanelModuleRealtimeMessageType(parsed.type)) {
    return isRecord(parsed.payload)
      ? { kind: "message", message: parsed as RealtimeMessage }
      : { kind: "ignored" };
  }
  if (parsed.type === "system.hello") {
    return parsed.payload !== null && isRecord(parsed.payload) && Object.keys(parsed.payload).length === 0
      ? { kind: "message", message: parsed as RealtimeEnvelope<"system.hello"> }
      : { kind: "ignored" };
  }
  if (parsed.type === "variables.changed") {
    return isVariablesChangedPayload(parsed.payload)
      ? { kind: "message", message: parsed as RealtimeEnvelope<"variables.changed"> }
      : { kind: "ignored" };
  }
  if (parsed.type === "overlay.changed") {
    return isRecord(parsed.payload) && typeof parsed.payload.overlayId === "string" && parsed.payload.overlayId.length > 0 &&
      typeof parsed.payload.revision === "number" && Number.isSafeInteger(parsed.payload.revision)
      ? { kind: "message", message: parsed as RealtimeEnvelope<"overlay.changed"> }
      : { kind: "ignored" };
  }
  if (parsed.type === "ads.schedule.updated") {
    return isRecord(parsed.payload) && isAdSchedule(parsed.payload.schedule) &&
      typeof parsed.payload.asOf === "string" && parsed.payload.asOf.length > 0
      ? { kind: "message", message: parsed as RealtimeEnvelope<"ads.schedule.updated"> }
      : { kind: "ignored" };
  }
  if (parsed.type === "stream.state.changed") {
    return isRecord(parsed.payload) &&
      (parsed.payload.state === "online" || parsed.payload.state === "offline") &&
      (parsed.payload.startedAt === null || typeof parsed.payload.startedAt === "string") &&
      typeof parsed.payload.changedAt === "string" && parsed.payload.changedAt.length > 0 &&
      (parsed.payload.checkedAt === undefined ||
        (typeof parsed.payload.checkedAt === "string" && parsed.payload.checkedAt.length > 0)) &&
      (parsed.payload.controls === undefined || isPanelChannelControls(parsed.payload.controls))
      ? { kind: "message", message: parsed as RealtimeEnvelope<"stream.state.changed"> }
      : { kind: "ignored" };
  }
  return isRecord(parsed.payload) && Array.isArray(parsed.payload.entries) &&
    parsed.payload.entries.every(isHint)
    ? { kind: "message", message: parsed as RealtimeEnvelope<"event_log.new"> }
    : { kind: "ignored" };
};

const reconnectDelay = (attempt: number): number => Math.min(
  MAX_RECONNECT_DELAY_MS,
  INITIAL_RECONNECT_DELAY_MS * (2 ** Math.min(attempt, 7)),
);

const socketNeedsRenewal = (event: CloseEvent): boolean =>
  event.code === SOCKET_EXPIRED_CODE || event.code === SOCKET_REVOKED_CODE ||
  /expired|revoked/i.test(event.reason);

const realtimeUrl = (channelId: string): string => {
  const url = new URL(`/ws/channels/${encodeURIComponent(channelId)}`, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

interface PanelSocketConnection {
  queryClient: QueryClient;
  socket: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  hasConnected: boolean;
  disposed: boolean;
  references: number;
  seenMessageIds: Set<string>;
}

const panelSocketConnections = new Map<string, PanelSocketConnection>();

const disposePanelSocket = (channelId: string, connection: PanelSocketConnection): void => {
  if (connection.disposed) return;
  connection.disposed = true;
  if (connection.reconnectTimer !== null) clearTimeout(connection.reconnectTimer);
  if (connection.cleanupTimer !== null) clearTimeout(connection.cleanupTimer);
  connection.reconnectTimer = null;
  connection.cleanupTimer = null;
  panelSocketConnections.delete(channelId);
  setDashboardRealtimeStatus(channelId, "offline");
  const socket = connection.socket;
  connection.socket = null;
  try { socket?.close(1000, "Panel channel unmounted"); } catch { /* The socket may already be closed. */ }
};

const schedulePanelReconnect = (channelId: string, connection: PanelSocketConnection): void => {
  if (connection.disposed || connection.reconnectTimer !== null) return;
  setDashboardRealtimeStatus(channelId, "reconnecting");
  const delay = reconnectDelay(connection.reconnectAttempt);
  connection.reconnectAttempt += 1;
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null;
    connectPanelSocket(channelId, connection);
  }, delay);
};

const connectPanelSocket = (channelId: string, connection: PanelSocketConnection): void => {
  if (connection.disposed) return;
  const WebSocketConstructor = window.WebSocket;
  if (typeof WebSocketConstructor !== "function") {
    setDashboardRealtimeStatus(channelId, "offline");
    return;
  }
  setDashboardRealtimeStatus(channelId, connection.reconnectAttempt === 0 ? "connecting" : "reconnecting");
  try {
    const socket = new WebSocketConstructor(realtimeUrl(channelId), REALTIME_PROTOCOL);
    connection.socket = socket;
    socket.addEventListener("open", () => {
      if (connection.disposed) return;
      if (connection.hasConnected) invalidateDashboardChannelQueries(connection.queryClient, channelId);
      connection.hasConnected = true;
      connection.reconnectAttempt = 0;
      setDashboardRealtimeStatus(channelId, "connected");
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      const parsed = parseRealtimeMessage(event.data, channelId);
      if (parsed.kind === "foreign-channel") {
        try { socket.close(1008, "Foreign channel"); } catch { /* The socket may already be closed. */ }
        return;
      }
      if (parsed.kind !== "message" || connection.seenMessageIds.has(parsed.message.id)) return;
      connection.seenMessageIds.add(parsed.message.id);
      invalidateDashboardRealtimeMessage(connection.queryClient, parsed.message);
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (connection.disposed) return;
      if (connection.socket === socket) connection.socket = null;
      if (socketNeedsRenewal(event) || event.code === 1008) {
        setDashboardRealtimeStatus(channelId, "renew");
        return;
      }
      schedulePanelReconnect(channelId, connection);
    });
  } catch {
    schedulePanelReconnect(channelId, connection);
  }
};

const acquirePanelSocket = (channelId: string, queryClient: QueryClient): (() => void) => {
  let connection = panelSocketConnections.get(channelId);
  if (connection !== undefined && connection.queryClient !== queryClient) {
    disposePanelSocket(channelId, connection);
    connection = undefined;
  }
  if (connection === undefined) {
    connection = {
      queryClient,
      socket: null,
      reconnectTimer: null,
      cleanupTimer: null,
      reconnectAttempt: 0,
      hasConnected: false,
      disposed: false,
      references: 0,
      seenMessageIds: new Set(),
    };
    panelSocketConnections.set(channelId, connection);
    connectPanelSocket(channelId, connection);
  }
  const activeConnection = connection;
  if (activeConnection.cleanupTimer !== null) {
    clearTimeout(activeConnection.cleanupTimer);
    activeConnection.cleanupTimer = null;
  }
  activeConnection.references += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeConnection.references -= 1;
    if (activeConnection.references !== 0 || activeConnection.cleanupTimer !== null) return;
    // React StrictMode remounts effects synchronously in development. Defer
    // disposal for one task so the second lease reuses this channel socket.
    activeConnection.cleanupTimer = setTimeout(() => {
      if (activeConnection.references === 0) disposePanelSocket(channelId, activeConnection);
    }, 0);
  };
};

/** The dashboard shell owns the channel socket, independent of the active page. */
export const useRealtimePanelMessages = (channelId: string | null, enabled: boolean): void => {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || channelId === null) return;
    return acquirePanelSocket(channelId, queryClient);
  }, [channelId, enabled, queryClient]);
};

/** Shares the shell socket state with the event feed without opening another connection. */
export const useRealtimeEventFeed = ({
  channelId,
  scrollToBeginning,
  refreshOnReturn,
}: {
  channelId: string;
  scrollToBeginning: () => void;
  refreshOnReturn?: () => void;
}): RealtimeFeedState => {
  const status = useDashboardRealtimeStatus(channelId);
  const jumpToBeginning = useCallback((): void => {
    scrollToBeginning();
    refreshOnReturn?.();
  }, [refreshOnReturn, scrollToBeginning]);
  return { status, jumpToBeginning };
};
