export const voteWinner = async (counts: readonly number[], ballotId: string): Promise<{ index: number; drawnByLot: boolean } | null> => {
  if (counts.length < 2 || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  const highest = Math.max(...counts);
  if (highest === 0) return null;
  const winners = counts.flatMap((count, index) => count === highest ? [index] : []);
  const single = winners[0];
  if (single === undefined) return null;
  if (winners.length === 1) return { index: single, drawnByLot: false };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ballotId));
  const randomValue = new DataView(digest).getUint32(0);
  return { index: winners[randomValue % winners.length] ?? single, drawnByLot: true };
};
