import { closeRealtimeUnboundOverlayTokenSockets, revokeRealtimeToken } from "./realtime";

const REALTIME_TOKEN_CLOSE_TIMEOUT_MS = 2_000;

const waitForRealtimeClose = async (
  operation: Promise<boolean>,
  timeoutMessage: string,
  failureMessage: string,
): Promise<boolean> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      operation,
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => { resolve("timeout"); }, REALTIME_TOKEN_CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (outcome === "timeout" || !outcome) {
      console.warn(timeoutMessage);
      return false;
    }
    return true;
  } catch (error: unknown) {
    console.warn(failureMessage, error);
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

export const closeRealtimeTokenBeforeResponse = (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  tokenId: string,
): Promise<boolean> => waitForRealtimeClose(
  revokeRealtimeToken(namespace, channelId, tokenId),
  "Realtime token revocation is pending; the Durable Object will retry.",
  "Realtime token revocation could not close the connection.",
);

export const closeRealtimeUnboundOverlayTokenBeforeResponse = (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  tokenId: string,
): Promise<boolean> => waitForRealtimeClose(
  closeRealtimeUnboundOverlayTokenSockets(namespace, channelId, tokenId),
  "Realtime legacy overlay socket closure is pending.",
  "Realtime legacy overlay sockets could not be closed.",
);
