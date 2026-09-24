import { revokeRealtimeToken } from "./realtime";

const REALTIME_TOKEN_CLOSE_TIMEOUT_MS = 2_000;

export const closeRealtimeTokenBeforeResponse = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  tokenId: string,
): Promise<boolean> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      revokeRealtimeToken(namespace, channelId, tokenId),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => { resolve("timeout"); }, REALTIME_TOKEN_CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (outcome === "timeout" || !outcome) {
      console.warn("Realtime token revocation is pending; the Durable Object will retry.");
      return false;
    }
    return true;
  } catch (error: unknown) {
    console.warn("Realtime token revocation could not close the connection.", error);
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};
