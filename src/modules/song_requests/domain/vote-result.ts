export const voteWinner = (counts: readonly number[]): number | null => {
  if (counts.length < 2 || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  const highest = Math.max(...counts);
  if (highest === 0) return null;
  const winners = counts.flatMap((count, index) => count === highest ? [index] : []);
  return winners.length === 1 ? winners[0] ?? null : null;
};
