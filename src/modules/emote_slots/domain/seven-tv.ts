export interface SevenTvSlotEmote {
  source: "seven_tv";
  code: string;
  sevenTvId: string;
  name: string;
  imageUrl: string;
}

export interface SevenTvActiveSet {
  setName: string;
  items: SevenTvSlotEmote[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeEmoteId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value);

const safeEmoteName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 64 && !/\s/u.test(value);

/** Reads only `emote_set.emotes`; user-wide emotes are deliberately ignored. */
export const parseSevenTvActiveSet = (value: unknown): SevenTvActiveSet | null => {
  if (!isRecord(value) || !isRecord(value.emote_set)) return null;
  const activeSet = value.emote_set;
  if (typeof activeSet.name !== "string" || activeSet.name.trim().length === 0 || activeSet.name.length > 80 ||
      !Array.isArray(activeSet.emotes) || activeSet.emotes.length > 1_000) return null;

  const items: SevenTvSlotEmote[] = [];
  for (const entry of activeSet.emotes) {
    if (!isRecord(entry) || !safeEmoteId(entry.id) || !safeEmoteName(entry.name)) return null;
    items.push({
      source: "seven_tv",
      code: entry.name,
      sevenTvId: entry.id,
      name: entry.name,
      imageUrl: `https://cdn.7tv.app/emote/${encodeURIComponent(entry.id)}/2x.webp`,
    });
  }
  return { setName: activeSet.name.trim(), items };
};

export const isSevenTvSymbolMissing = (
  symbol: { source: string; sevenTvId?: string | undefined },
  activeItems: readonly { source: string; sevenTvId?: string | undefined }[],
): boolean => symbol.source === "seven_tv" && (symbol.sevenTvId === undefined ||
  !activeItems.some((item) => item.source === "seven_tv" && item.sevenTvId === symbol.sevenTvId));
