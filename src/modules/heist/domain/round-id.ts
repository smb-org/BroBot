export const heistRoundIdForMessage = async (messageId: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(messageId));
  const hash = [...new Uint8Array(digest)].slice(0, 20).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `heist-${hash}`;
};
