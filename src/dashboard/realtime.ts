import { useCallback, useEffect, useRef, useState } from "react";

import type {
  PanelEventFilters,
} from "../panel-contract";
import type {
  RealtimeEnvelope,
  RealtimeEventLogHint,
  RealtimeMessage,
} from "../realtime-contract";
import { eventToneEntries, type EventCode } from "./locale";

const REALTIME_PROTOCOL = "brobot.v1";
const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;
const RECONNECT_GRACE_MS = 400;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BATCH_DELAY_MS = 120;

export type RealtimeFeedStatus = "connecting" | "connected" | "reconnecting" | "offline" | "renew";

export interface RealtimeFeedState {
  status: RealtimeFeedStatus;
  pendingCount: number;
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

const isKnownEnvelope = (value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1;
  id: string;
  createdAt: string;
  channelId: string;
  type: RealtimeMessage["type"];
  payload: unknown;
} => typeof value.version === "number" && value.version === 1 &&
  typeof value.id === "string" && value.id.length > 0 &&
  typeof value.createdAt === "string" && value.createdAt.length > 0 &&
  typeof value.channelId === "string" && value.channelId.length > 0 &&
  (value.type === "system.hello" || value.type === "event_log.new");

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
  if (parsed.type === "system.hello") {
    return parsed.payload !== null && isRecord(parsed.payload) && Object.keys(parsed.payload).length === 0
      ? { kind: "message", message: parsed as RealtimeEnvelope<"system.hello"> }
      : { kind: "ignored" };
  }
  if (!isRecord(parsed.payload) || !Array.isArray(parsed.payload.entries) ||
      !parsed.payload.entries.every(isHint)) return { kind: "ignored" };
  return { kind: "message", message: parsed as RealtimeEnvelope<"event_log.new"> };
};

const eventMetadata = (code: string) =>
  Object.prototype.hasOwnProperty.call(eventToneEntries, code) ? eventToneEntries[code as EventCode] : null;

/** Same origin logic as the event route: operational entries are module diagnostics. */
export const realtimeHintMatchesFilters = (
  hint: RealtimeEventLogHint,
  filters: PanelEventFilters,
): boolean => {
  if (filters.module !== null && hint.moduleId !== filters.module) return false;
  if (filters.person !== null && hint.actorUserId !== filters.person) return false;
  const metadata = eventMetadata(hint.code);
  if (filters.origin !== null) {
    const isModuleDiagnostic = hint.moduleId !== "channel_events";
    if (filters.origin === "module" !== isModuleDiagnostic) return false;
  }
  const selectedTones = filters.tones !== undefined && filters.tones.length > 0
    ? filters.tones
    : filters.tone === null ? [] : [filters.tone];
  if (selectedTones.length > 0 && (metadata === null || metadata.tone === undefined || !selectedTones.includes(metadata.tone))) return false;
  return true;
};

const filterKey = (filters: PanelEventFilters): string => [
  filters.origin ?? "",
  filters.module ?? "",
  filters.tone ?? "",
  [...(filters.tones ?? [])].sort().join(","),
  filters.person ?? "",
].join("\u001f");

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

export const useRealtimeEventFeed = ({
  channelId,
  filters,
  atBeginning,
  refreshFirstPage,
  scrollToBeginning,
}: {
  channelId: string;
  filters: PanelEventFilters;
  atBeginning: () => boolean;
  refreshFirstPage: () => Promise<void>;
  scrollToBeginning: () => void;
}): RealtimeFeedState => {
  const [status, setStatus] = useState<RealtimeFeedStatus>("connecting");
  const [pendingCount, setPendingCount] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectGraceTimerRef = useRef<number | null>(null);
  const batchTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const hasConnectedRef = useRef(false);
  const fatalProtocolErrorRef = useRef(false);
  const seenMessageIdsRef = useRef(new Set<string>());
  const pendingEventIdsRef = useRef(new Set<string>());
  const refreshFirstPageRef = useRef(refreshFirstPage);
  const atBeginningRef = useRef(atBeginning);
  const scrollToBeginningRef = useRef(scrollToBeginning);
  const filtersRef = useRef(filters);
  const refreshPendingRef = useRef<(ids: ReadonlySet<string>) => void>(() => undefined);

  useEffect(() => {
    refreshFirstPageRef.current = refreshFirstPage;
    atBeginningRef.current = atBeginning;
    scrollToBeginningRef.current = scrollToBeginning;
    filtersRef.current = filters;
  }, [atBeginning, filters, refreshFirstPage, scrollToBeginning]);

  const updatePendingCount = useCallback((): void => {
    setPendingCount(pendingEventIdsRef.current.size);
  }, []);

  const clearPending = useCallback((ids?: ReadonlySet<string>): void => {
    if (ids === undefined) pendingEventIdsRef.current.clear();
    else for (const id of ids) pendingEventIdsRef.current.delete(id);
    updatePendingCount();
  }, [updatePendingCount]);

  const refreshPending = useCallback((ids: ReadonlySet<string>): void => {
    void refreshFirstPageRef.current().then(() => {
      clearPending(ids);
      if (pendingEventIdsRef.current.size > 0 && atBeginningRef.current() && batchTimerRef.current === null) {
        batchTimerRef.current = window.setTimeout(() => {
          batchTimerRef.current = null;
          const remaining = new Set(pendingEventIdsRef.current);
          if (remaining.size > 0 && atBeginningRef.current()) refreshPendingRef.current(remaining);
        }, BATCH_DELAY_MS);
      }
    }).catch(() => {
      updatePendingCount();
    });
  }, [clearPending, updatePendingCount]);

  useEffect(() => {
    refreshPendingRef.current = refreshPending;
  }, [refreshPending]);

  const flushPending = useCallback((): void => {
    const ids = new Set(pendingEventIdsRef.current);
    if (ids.size === 0) return;
    if (atBeginningRef.current()) {
      refreshPending(ids);
    } else {
      updatePendingCount();
    }
  }, [refreshPending, updatePendingCount]);

  const scheduleBatch = useCallback((): void => {
    if (batchTimerRef.current !== null) return;
    batchTimerRef.current = window.setTimeout(() => {
      batchTimerRef.current = null;
      flushPending();
    }, BATCH_DELAY_MS);
  }, [flushPending]);

  const jumpToBeginning = useCallback((): void => {
    scrollToBeginningRef.current();
    const ids = new Set(pendingEventIdsRef.current);
    if (ids.size > 0) refreshPending(ids);
  }, [refreshPending]);

  const currentFilterKey = filterKey(filters);
  useEffect(() => {
    clearPending();
    if (batchTimerRef.current !== null) {
      window.clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
  }, [clearPending, currentFilterKey]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    reconnectAttemptRef.current = 0;
    hasConnectedRef.current = false;
    fatalProtocolErrorRef.current = false;
    seenMessageIdsRef.current.clear();
    clearPending();

    const clearReconnectTimers = (): void => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (reconnectGraceTimerRef.current !== null) {
        window.clearTimeout(reconnectGraceTimerRef.current);
        reconnectGraceTimerRef.current = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (disposed || fatalProtocolErrorRef.current || reconnectTimerRef.current !== null) return;
      const delay = reconnectDelay(reconnectAttemptRef.current);
      reconnectAttemptRef.current += 1;
      reconnectGraceTimerRef.current = window.setTimeout(() => {
        reconnectGraceTimerRef.current = null;
        if (!disposed && !fatalProtocolErrorRef.current) setStatus("reconnecting");
      }, RECONNECT_GRACE_MS);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    const closeWithProtocolError = (): void => {
      fatalProtocolErrorRef.current = true;
      setStatus("offline");
      try {
        socket?.close(1008, "Fremder Kanal");
      } catch {
        // The socket may already be closed between receipt and close.
      }
    };

    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (typeof event.data !== "string") return;
      const parsed = parseRealtimeMessage(event.data, channelId);
      if (parsed.kind === "foreign-channel") {
        closeWithProtocolError();
        return;
      }
      if (parsed.kind !== "message" || seenMessageIdsRef.current.has(parsed.message.id)) return;
      seenMessageIdsRef.current.add(parsed.message.id);
      if (parsed.message.type !== "event_log.new") return;
      const hints = parsed.message.payload.entries.filter((hint) => realtimeHintMatchesFilters(hint, filtersRef.current));
      for (const hint of hints) pendingEventIdsRef.current.add(hint.eventId);
      if (hints.length > 0) {
        updatePendingCount();
        scheduleBatch();
      }
    };

    const handleClose = (event: CloseEvent): void => {
      socketRef.current = null;
      if (disposed) return;
      if (reconnectGraceTimerRef.current !== null) {
        window.clearTimeout(reconnectGraceTimerRef.current);
        reconnectGraceTimerRef.current = null;
      }
      if (socketNeedsRenewal(event)) {
        fatalProtocolErrorRef.current = true;
        setStatus("renew");
        return;
      }
      if (!fatalProtocolErrorRef.current) scheduleReconnect();
    };

    const handleOpen = (): void => {
      if (disposed) return;
      const isReconnection = hasConnectedRef.current;
      hasConnectedRef.current = true;
      reconnectAttemptRef.current = 0;
      if (reconnectGraceTimerRef.current !== null) {
        window.clearTimeout(reconnectGraceTimerRef.current);
        reconnectGraceTimerRef.current = null;
      }
      setStatus("connected");
      if (isReconnection) {
        const ids = new Set(pendingEventIdsRef.current);
        void refreshFirstPageRef.current()
          .then(() => {
            clearPending(ids);
          })
          .catch(() => {
            updatePendingCount();
          });
      }
    };

    function connect(): void {
      if (disposed || fatalProtocolErrorRef.current) return;
      const WebSocketConstructor = window.WebSocket;
      if (typeof WebSocketConstructor !== "function") {
        setStatus("offline");
        return;
      }
      try {
        socket = new WebSocketConstructor(realtimeUrl(channelId), REALTIME_PROTOCOL);
        socketRef.current = socket;
        socket.addEventListener("open", handleOpen);
        socket.addEventListener("message", handleMessage);
        socket.addEventListener("close", handleClose);
      } catch {
        scheduleReconnect();
      }
    }

    connect();
    return () => {
      disposed = true;
      clearReconnectTimers();
      if (batchTimerRef.current !== null) {
        window.clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      if (socketRef.current === socket) socketRef.current = null;
      try {
        socket?.close(1000, "Panel verlassen");
      } catch {
        // The socket may already be closed.
      }
    };
  }, [channelId, clearPending, scheduleBatch, updatePendingCount]);

  return { status, pendingCount, jumpToBeginning };
};
