export interface StatisticsStreamWindow {
  windowStart: string;
  streamId: string | null;
  messages: number;
  emotes: number;
  viewerCount: number | null;
  chatters: number | null;
  activeChatters: number | null;
}

type StatisticsTimelineEventKind =
  | "stream_online"
  | "stream_offline"
  | "channel_metadata"
  | "clip_created"
  | "ad_break"
  | "emote_spike";

export interface StatisticsTimelineEvent {
  kind: StatisticsTimelineEventKind;
  occurredAt: string;
  detail: Readonly<Record<string, unknown>>;
}

export interface StatisticsStreamSummary {
  streamId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  title: string | null;
  categories: readonly string[];
  averageViewers: number | null;
  peakViewers: number | null;
  peakAt: string | null;
  messages: number;
  averageActiveChatters: number | null;
  clips: number;
  /** Latest statistics window used only as the stable list-page cursor key. */
  cursorAt?: string;
}

export interface StatisticsStreamListResponse {
  streams: readonly StatisticsStreamSummary[];
  nextCursor: string | null;
}

export interface StatisticsBitrateWindow {
  windowStart: number;
  bitrateAvg: number;
  bitrateMin: number;
  bitrateMax: number;
  bitrateP10: number;
}

type StatisticsStreamEventType = "start" | "offline" | "metadata" | "clip" | "ad" | "drop" | "emoteSpike";

export interface StatisticsStreamEvent {
  id: string;
  type: StatisticsStreamEventType;
  at: string;
  recoveredAt?: string;
  durationSeconds?: number;
  title?: string | null;
  oldTitle?: string | null;
  category?: string | null;
  oldCategory?: string | null;
  clipId?: string;
  emotes?: number;
  text?: string;
}

export interface StatisticsStreamDetailResponse {
  summary: StatisticsStreamSummary;
  windows: readonly StatisticsStreamWindow[];
  bitrateWindows: readonly StatisticsBitrateWindow[];
  events: readonly StatisticsStreamEvent[];
}

export type StatisticsTrendsWeeks = 4 | 12 | 52;

export interface StatisticsTrendKpis {
  streams: number;
  streamHours: number;
  averageViewers: number | null;
  messagesPerMinute: number | null;
}

export interface StatisticsTrendWeek {
  weekStart: string;
  isoWeek: number;
  averageViewers: number | null;
  streamHours: number;
}

export interface StatisticsTrendHeatmapCell {
  weekday: number;
  hour: number;
  averageViewers: number | null;
  streams: number;
}

export interface StatisticsTrendCategory {
  name: string;
  streams: number;
  streamHours: number;
  averageViewers: number | null;
  messagesPerMinute: number | null;
}

export interface StatisticsTrendsResponse {
  weeks: StatisticsTrendsWeeks;
  timeZone: string;
  range: { start: string; end: string };
  previousRange: { start: string; end: string };
  kpis: StatisticsTrendKpis;
  previousKpis: StatisticsTrendKpis;
  weekly: readonly StatisticsTrendWeek[];
  heatmap: readonly StatisticsTrendHeatmapCell[];
  categories: readonly StatisticsTrendCategory[];
}
