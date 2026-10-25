export const STATISTICS_WINDOW_SECONDS = 5 * 60;
export const STATISTICS_WINDOW_MILLISECONDS = STATISTICS_WINDOW_SECONDS * 1_000;

export interface StatisticsChatActivity {
  windowStart: string;
  receivedAt: string;
  emotes: number;
}

/** Start of the UTC-epoch-aligned five-minute window containing `timeMs` (shared with other window series). */
export const statisticsWindowStartMs = (timeMs: number): number =>
  Math.floor(timeMs / STATISTICS_WINDOW_MILLISECONDS) * STATISTICS_WINDOW_MILLISECONDS;

export const statisticsWindowStart = (receivedAt: string): number | null => {
  const received = Date.parse(receivedAt);
  return Number.isFinite(received) ? statisticsWindowStartMs(received) : null;
};
const recordValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export const countStatisticsEmotes = (payload: Readonly<Record<string, unknown>>): number => {
  const message = recordValue(payload.message);
  if (message === null || !Array.isArray(message.fragments)) return 0;
  return message.fragments.reduce((count: number, fragment: unknown) =>
    recordValue(fragment)?.type === "emote" ? count + 1 : count, 0);
};
