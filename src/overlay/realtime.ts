import {
  OVERLAY_TOKEN_SUBPROTOCOL_PREFIX,
  REALTIME_PROTOCOL,
} from "../realtime-contract";

const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;
const SOCKET_POLICY_VIOLATION_CODE = 1008;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
): (() => void) => {
  let disposed = false;
  let fatalProtocolError = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let channelId: string | null = null;

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
      connect();
    }, delay);
  };

  const failProtocol = (activeSocket: WebSocket): void => {
    fatalProtocolError = true;
    stopReconnectTimer();
    try {
      activeSocket.close(1002, "Realtime protocol error");
    } catch {
      // The socket may have closed while the envelope was being read.
    }
  };

  function connect(): void {
    if (disposed || fatalProtocolError) return;
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
      reconnectAttempt = 0;
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
      }
    });

    activeSocket.addEventListener("close", (event: CloseEvent) => {
      if (socket === activeSocket) socket = null;
      if (disposed || fatalProtocolError) return;
      if (event.code === SOCKET_EXPIRED_CODE || event.code === SOCKET_REVOKED_CODE ||
          event.code === SOCKET_POLICY_VIOLATION_CODE) {
        if (event.code === SOCKET_POLICY_VIOLATION_CODE) fatalProtocolError = true;
        onTerminalClose?.();
        return;
      }
      scheduleReconnect();
    });
  }

  connect();
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
