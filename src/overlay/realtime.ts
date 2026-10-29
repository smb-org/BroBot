import {
  OVERLAY_ACCESS_BOUND_CLOSE_CODE,
  OVERLAY_TOKEN_SUBPROTOCOL_PREFIX,
  REALTIME_PROTOCOL,
} from "../realtime-contract";
import type { RealtimeEnvelope } from "../realtime-contract";
import type { ModuleOverlayRealtimeEnvelope } from "../realtime-contract";
import { isModuleOverlayRealtimeMessageType } from "../realtime-contract";
import { RealtimeMessageIdCache } from "../realtime-message-ids";

const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;
const SOCKET_POLICY_VIOLATION_CODE = 1008;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;
const STABLE_CONNECTION_PERIOD_MS = 30_000;
const ABNORMAL_CLOSE_REVALIDATION_THRESHOLD = 3;
const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

type OverlayRealtimeState = "connecting" | "connected" | "reconnecting" | "offline";

export interface OverlayRealtimeCallbacks {
  onStateChange?: (state: OverlayRealtimeState) => void;
  onOpen?: (reconnected: boolean, bootstrapReused?: boolean) => void;
  onBootstrap?: (payload: unknown) => boolean;
  onMessage?: (message: RealtimeEnvelope<"variables.changed">) => void;
  onOverlayChanged?: (message: RealtimeEnvelope<"overlay.changed">) => void;
  onModuleMessage?: (message: ModuleOverlayRealtimeEnvelope<`modul.${string}.${string}`>) => void;
  onTokenBound?: () => void;
}

export interface OverlayRealtimeOptions {
  bootstrapUrl?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isVariablesChangedPayload = (value: unknown): boolean => isRecord(value) &&
  Array.isArray(value.set) && value.set.every((entry) => isRecord(entry) &&
    typeof entry.name === "string" && VARIABLE_NAME_PATTERN.test(entry.name) &&
    typeof entry.value === "number" && Number.isSafeInteger(entry.value)) &&
  Array.isArray(value.removed) && value.removed.every((name) =>
    typeof name === "string" && VARIABLE_NAME_PATTERN.test(name));

const isOverlayChangedPayload = (value: unknown): boolean => isRecord(value) &&
  typeof value.overlayId === "string" && value.overlayId.length > 0 &&
  typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 1;

const realtimeUrl = (): string => {
  const url = new URL("/ws/overlay", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const reconnectDelay = (attempt: number): number => {
  const exponentialDelay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    INITIAL_RECONNECT_DELAY_MS * (2 ** Math.min(attempt, 7)),
  );
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.round(exponentialDelay * (0.5 + Math.random())));
};

/** Opens the token-authenticated, one-way overlay socket and retries transient failures. */
export const connectOverlayRealtime = (
  token: string,
  onTerminalClose?: () => void,
  callbacks: OverlayRealtimeCallbacks = {},
  options: OverlayRealtimeOptions = {},
): (() => void) => {
  let disposed = false;
  let fatalProtocolError = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let stableTimer: number | null = null;
  let reconnectAttempt = 0;
  let channelId: string | null = null;
  let hasConnected = false;
  let consecutiveAbnormalCloses = 0;
  let authorizationCheck: Promise<boolean> | null = null;
  let bootstrapReusedBeforeOpen = false;
  let state: OverlayRealtimeState = "offline";
  const seenMessageIds = new RealtimeMessageIdCache();

  const setState = (next: OverlayRealtimeState): void => {
    if (state === next) return;
    state = next;
    callbacks.onStateChange?.(next);
  };

  const acceptEvent = (id: string): boolean => {
    if (seenMessageIds.has(id)) return false;
    seenMessageIds.add(id);
    return true;
  };

  const stopReconnectTimer = (): void => {
    if (reconnectTimer === null) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const stopStableTimer = (): void => {
    if (stableTimer === null) return;
    window.clearTimeout(stableTimer);
    stableTimer = null;
  };

  const scheduleReconnect = (): void => {
    if (disposed || fatalProtocolError || reconnectTimer !== null) return;
    setState("reconnecting");
    const delay = reconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect(true);
    }, delay);
  };

  const checkAuthorization = (): Promise<boolean> => {
    if (authorizationCheck !== null) return authorizationCheck;
    bootstrapReusedBeforeOpen = false;
    authorizationCheck = fetch(options.bootstrapUrl ?? "/api/overlay/bootstrap", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }).then(async (response) => {
      if (response.status === 401 || response.status === 403) return false;
      if (response.ok && callbacks.onBootstrap !== undefined) {
        try {
          const payload: unknown = await response.json();
          bootstrapReusedBeforeOpen = callbacks.onBootstrap(payload);
        } catch {
          bootstrapReusedBeforeOpen = false;
        }
      }
      return true;
    })
      // A failed check caused by a network/server problem is transient. Keep
      // the current frame and allow the socket retry to run.
      .catch(() => true)
      .finally(() => { authorizationCheck = null; });
    return authorizationCheck;
  };

  const terminalAuthorizationFailure = (): void => {
    if (disposed || fatalProtocolError) return;
    fatalProtocolError = true;
    stopReconnectTimer();
    setState("offline");
    onTerminalClose?.();
  };

  const revalidateAuthorization = async (): Promise<boolean> => {
    const authorized = await checkAuthorization();
    if (!authorized) terminalAuthorizationFailure();
    return authorized;
  };

  const canConnect = (): boolean => !disposed && !fatalProtocolError;

  const failProtocol = (activeSocket: WebSocket): void => {
    fatalProtocolError = true;
    stopReconnectTimer();
    setState("offline");
    try {
      activeSocket.close(1002, "Realtime protocol error");
    } catch {
      // The socket may have closed while the envelope was being read.
    }
  };

  async function connect(revalidate = false): Promise<void> {
    if (!canConnect()) return;
    setState(hasConnected || reconnectAttempt > 0 ? "reconnecting" : "connecting");
    if (revalidate && !await revalidateAuthorization()) return;
    if (!canConnect()) return;
    const WebSocketConstructor = window.WebSocket;
    if (typeof WebSocketConstructor !== "function") {
      scheduleReconnect();
      return;
    }

    let activeSocket: WebSocket;
    try {
      activeSocket = new WebSocketConstructor(realtimeUrl(), [
        REALTIME_PROTOCOL,
        `${OVERLAY_TOKEN_SUBPROTOCOL_PREFIX}${token}`,
      ]);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = activeSocket;

    activeSocket.addEventListener("open", () => {
      if (disposed) return;
      if (activeSocket.protocol !== REALTIME_PROTOCOL) {
        failProtocol(activeSocket);
        return;
      }
      const reconnected = hasConnected;
      hasConnected = true;
      stopStableTimer();
      stableTimer = window.setTimeout(() => {
        stableTimer = null;
        reconnectAttempt = 0;
      }, STABLE_CONNECTION_PERIOD_MS);
      consecutiveAbnormalCloses = 0;
      setState("connected");
      const bootstrapReused = reconnected && bootstrapReusedBeforeOpen;
      bootstrapReusedBeforeOpen = false;
      callbacks.onOpen?.(reconnected, bootstrapReused);
    });

    activeSocket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.channelId !== "string" ||
          typeof parsed.id !== "string" || parsed.id.length === 0) return;
      if (channelId !== null && parsed.channelId !== channelId) {
        failProtocol(activeSocket);
        return;
      }
      if (parsed.type === "system.hello" && isRecord(parsed.payload) &&
          Object.keys(parsed.payload).length === 0) {
        channelId ??= parsed.channelId;
        seenMessageIds.add(parsed.id);
        return;
      }
      if (channelId === null) return;
      if (parsed.type === "variables.changed" && isVariablesChangedPayload(parsed.payload) &&
          acceptEvent(parsed.id)) {
        callbacks.onMessage?.(parsed as RealtimeEnvelope<"variables.changed">);
      } else if (parsed.type === "overlay.changed" && isOverlayChangedPayload(parsed.payload) &&
          acceptEvent(parsed.id)) {
        callbacks.onOverlayChanged?.(parsed as RealtimeEnvelope<"overlay.changed">);
      } else if (typeof parsed.type === "string" && isModuleOverlayRealtimeMessageType(parsed.type) &&
          isRecord(parsed.payload) && acceptEvent(parsed.id)) {
        callbacks.onModuleMessage?.(parsed as ModuleOverlayRealtimeEnvelope<`modul.${string}.${string}`>);
      }
    });

    activeSocket.addEventListener("close", (event: CloseEvent) => {
      if (socket === activeSocket) socket = null;
      stopStableTimer();
      if (disposed || fatalProtocolError) return;
      if (event.code === OVERLAY_ACCESS_BOUND_CLOSE_CODE) {
        fatalProtocolError = true;
        stopReconnectTimer();
        setState("offline");
        callbacks.onTokenBound?.();
        return;
      }
      if (event.code === SOCKET_EXPIRED_CODE || event.code === SOCKET_REVOKED_CODE ||
          event.code === SOCKET_POLICY_VIOLATION_CODE) {
        if (event.code === SOCKET_POLICY_VIOLATION_CODE) fatalProtocolError = true;
        setState("offline");
        onTerminalClose?.();
        return;
      }
      if (event.code === 1006) {
        consecutiveAbnormalCloses += 1;
        if (consecutiveAbnormalCloses === ABNORMAL_CLOSE_REVALIDATION_THRESHOLD) {
          void revalidateAuthorization();
        }
      } else {
        consecutiveAbnormalCloses = 0;
      }
      scheduleReconnect();
    });
  }

  void connect();
  return () => {
    disposed = true;
    stopReconnectTimer();
    stopStableTimer();
    setState("offline");
    const activeSocket = socket;
    socket = null;
    try {
      activeSocket?.close(1000, "Overlay stopped");
    } catch {
      // The socket may already be closed.
    }
  };
};
