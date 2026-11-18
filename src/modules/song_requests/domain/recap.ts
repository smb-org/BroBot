interface RecapTexts {
  recapPlayed: (count: number) => string;
  recapThanks: (names: string) => string;
}

export const songRequestRecapMessage = (
  texts: RecapTexts,
  count: number,
  requesterNames: readonly string[],
): string => {
  const names = requesterNames.slice(0, 3);
  return `${texts.recapPlayed(count)}${names.length === 0 ? "" : texts.recapThanks(names.join(", "))}`;
};
