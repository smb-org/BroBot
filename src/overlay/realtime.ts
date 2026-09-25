import {
  OVERLAY_ACCESS_BOUND_CLOSE_CODE,
  OVERLAY_TOKEN_SUBPROTOCOL_PREFIX,
  REALTIME_PROTOCOL,
} from "../realtime-contract";
import type { RealtimeEnvelope } from "../realtime-contract";

const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;
const SOCKET_POLICY_VIOLATION_CODE = 1008;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;
const ABNORMAL_CLOSE_REVALIDATION_THRESHOLD = 3;
const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

export interface OverlayRealtimeCallbacks {
  onOpen?: (reconnected: boolean) => void;
  onMessage?: (message: RealtimeEnvelope<"variables.changed">) => void;
  onOverlayChanged?: (message: RealtimeEnvelope<"overlay.changed">) => void;
  onTokenBound?: () => void;
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

const reconnectDelay = (attempt: number): number => Math.min(
  MAX_RECONNECT_DELAY_MS,
  INITIAL_RECONNECT_DELAY_MS * (2 ** Math.min(attempt, 7)),
);

/** Opens the token-authenticated, one-way overlay socket and retries transient failures. */
export const connectOverlayRealtime = (
  token: string,
  onTerminalClose?: () => void,
  callbacks: OverlayRealtimeCallbacks = {},
): (() => void) => {
  let disposed = false;
  let fatalProtocolError = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let channelId: string | null = null;
  let hasConnected = false;
  let consecutiveAbnormalCloses = 0;
  let authorizationCheck: Promise<boolean> | null = null;

  const stopReconnectTimer = (): void => {
    if (reconnectTimer === null) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = (): void => {
    if (disposed || fatalProtocolError || reconnectTimer !== null) return;
    const delay = reconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect(true);
    }, delay);
  };

  const checkAuthorization = (): Promise<boolean> => {
    if (authorizationCheck !== null) return authorizationCheck;
    authorizationCheck = fetch("/api/overlay/bootstrap", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }).then((response) => response.status !== 401 && response.status !== 403)
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
    try {
      activeSocket.close(1002, "Realtime protocol error");
    } catch {
      // The socket may have closed while the envelope was being read.
    }
  };

  async function connect(revalidate = false): Promise<void> {
    if (!canConnect()) return;
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
      reconnectAttempt = 0;
      consecutiveAbnormalCloses = 0;
      callbacks.onOpen?.(reconnected);
    });

    activeSocket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.channelId !== "string") return;
      if (channelId !== null && parsed.channelId !== channelId) {
        failProtocol(activeSocket);
        return;
      }
      if (parsed.type === "system.hello" && isRecord(parsed.payload) &&
          Object.keys(parsed.payload).length === 0) {
        channelId ??= parsed.channelId;
        return;
      }
      if (channelId === null) return;
      if (parsed.type === "variables.changed" && isVariablesChangedPayload(parsed.payload)) {
        callbacks.onMessage?.(parsed as RealtimeEnvelope<"variables.changed">);
      } else if (parsed.type === "overlay.changed" && isOverlayChangedPayload(parsed.payload)) {
        callbacks.onOverlayChanged?.(parsed as RealtimeEnvelope<"overlay.changed">);
      }
    });

    activeSocket.addEventListener("close", (event: CloseEvent) => {
      if (socket === activeSocket) socket = null;
      if (disposed || fatalProtocolError) return;
      if (event.code === OVERLAY_ACCESS_BOUND_CLOSE_CODE) {
        fatalProtocolError = true;
        stopReconnectTimer();
        callbacks.onTokenBound?.();
        return;
      }
      if (event.code === SOCKET_EXPIRED_CODE || event.code === SOCKET_REVOKED_CODE ||
          event.code === SOCKET_POLICY_VIOLATION_CODE) {
        if (event.code === SOCKET_POLICY_VIOLATION_CODE) fatalProtocolError = true;
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
    const activeSocket = socket;
    socket = null;
    try {
      activeSocket?.close(1000, "Overlay stopped");
    } catch {
      // The socket may already be closed.
    }
  };
};
