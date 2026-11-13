import type {
  ModuleAlarmContext,
  ModuleEvent,
  ModuleExecutionContext,
  ModuleResult,
  ModuleScheduleInputChangeReason,
  ModuleTimelineEvent,
  ModuleStatisticsWindow,
} from "../contract";
import { chatStatusMeetsMinimumTier } from "../contract";
import { statisticsSettingsSchema, type StatisticsSettings } from "./contracts";
import { wordCommandTexts } from "./locale";
import {
  addStatisticsWordCount,
  calculateStatisticsWordCount,
  STATISTICS_WORD_BASELINE_LIMIT,
  STATISTICS_WORD_RARE_HIDE_MILLISECONDS,
  STATISTICS_WORD_STREAM_IDLE_MILLISECONDS,
  STATISTICS_WORD_STREAM_MERGE_LIMIT,
  STATISTICS_WINDOW_MILLISECONDS,
  foldStatisticsWord,
  statisticsWindowStartMs,
  type StatisticsWordCountValue,
} from "./domain";

const EMOTE_SPIKE_BASELINE_WINDOWS = 12;
const EMOTE_SPIKE_MINIMUM_COUNT = 10;
const EMOTE_SPIKE_MULTIPLIER = 3;

interface StoredStreamState {
  state: string;
  stream_id: string | null;
  started_at: string | null;
}

const emptyResult = (): ModuleResult => ({ actions: [], diagnostics: [] });

const recordValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const nextBoundary = (time: number): number =>
  statisticsWindowStartMs(time) + STATISTICS_WINDOW_MILLISECONDS;

const sampledCount = async (read: (() => Promise<number | null>) | undefined): Promise<number | null> => {
  if (read === undefined) return null;
  try {
    const value = await read();
    return validCount(value) ? value : null;
  } catch {
    return null;
  }
};

interface StatisticsWordBaselineRow {
  word: string;
  total_count: number;
  last_seen_at: string;
  display_word: string;
}

interface StatisticsWordCommandStreamState {
  state: string;
  stream_id: string | null;
}

const wordCommandReply = (
  language: "de" | "en",
  word: string,
  streamIsLive: boolean,
  streamCount: number,
  totalCount: number,
): string => {
  const number = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 });
  if (streamIsLive) return language === "de"
    ? `${word}: in diesem Stream ${number.format(streamCount)}×, insgesamt ${number.format(totalCount)}×`
    : `${word}: ${number.format(streamCount)}× this stream, ${number.format(totalCount)}× in total`;
  return language === "de"
    ? `${word}: insgesamt ${number.format(totalCount)}×`
    : `${word}: ${number.format(totalCount)}× in total`;
};

const unknownWordReply = wordCommandTexts.unknownReply;

const processStatisticsWordCommand = async (
  event: ModuleEvent<StatisticsSettings>,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (!event.settings.wordCommand.enabled) return emptyResult();
  const payload = event.payload;
  const userId = payload.chatter_user_id;
  const messageId = payload.message_id;
  const messageText = recordValue(payload.message)?.text;
  if (typeof userId !== "string" || typeof messageId !== "string" || messageId.length === 0 ||
      typeof messageText !== "string") return emptyResult();
  if (await context.botUserId?.() === userId) return emptyResult();
  const sourceBroadcasterUserId = payload.source_broadcaster_user_id;
  if (typeof sourceBroadcasterUserId === "string" && sourceBroadcasterUserId !== event.channelId) return emptyResult();
  if (!chatStatusMeetsMinimumTier(event.chatStatus, event.settings.wordCommand.minimumChatStatus)) return emptyResult();

  const [command, argument] = messageText.trim().split(/\s+/u);
  if (command?.toLowerCase() !== event.settings.wordCommand.command || argument === undefined || argument.length === 0) {
    return emptyResult();
  }
  const word = foldStatisticsWord(argument);
  if (word.length === 0) return emptyResult();

  if (event.settings.wordCommand.cooldownSeconds > 0 &&
      !await context.points.claimCooldown("word-command:global", event.settings.wordCommand.cooldownSeconds)) {
    return emptyResult();
  }
  if (event.settings.wordCommand.userCooldownSeconds > 0 &&
      !await context.points.claimCooldown(`word-command:user:${userId}`, event.settings.wordCommand.userCooldownSeconds)) {
    return emptyResult();
  }

  const streamState = await context.DB.prepare(
    "SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?",
  ).bind(event.channelId).first<StatisticsWordCommandStreamState>();
  const streamIsLive = streamState?.state === "online";
  const runningStreamId = streamState?.state === "online" ? streamState.stream_id : null;
  const readWordCountForLookup = context.statisticsChat?.readWordCountForLookup;
  if (runningStreamId !== null && readWordCountForLookup === undefined) return emptyResult();
  const wordLookup = runningStreamId === null || readWordCountForLookup === undefined
    ? { batches: [], streamWord: null } as const
    : await readWordCountForLookup(runningStreamId, word);
  const pendingBatches = wordLookup.batches;
  const streamWord = wordLookup.streamWord;

  const baselineStatement = context.DB.prepare(
    `SELECT word, total_count, last_seen_at, display_word
       FROM channel_word_frequency_baseline WHERE channel_id = ?
      ORDER BY total_count DESC, word ASC`,
  ).bind(event.channelId);
  const mergedBatchStatement = runningStreamId === null ? null : context.DB.prepare(
    `SELECT batch FROM channel_word_frequency_streams
      WHERE channel_id = ? AND stream_id = ? AND merged_at IS NOT NULL`,
  ).bind(event.channelId, runningStreamId);
  const readResults = await context.DB.batch([
    baselineStatement,
    ...(mergedBatchStatement === null ? [] : [mergedBatchStatement]),
  ]);
  const baselineRows = (readResults[0] as D1Result<StatisticsWordBaselineRow>).results;
  const mergedBatches = new Set(mergedBatchStatement === null
    ? []
    : (readResults[1] as D1Result<{ batch: number }>).results.map(({ batch }) => batch));

  const baselineCounts = new Map<string, StatisticsWordCountValue>();
  const pendingCounts = new Map<string, StatisticsWordCountValue>();
  const fullStreamCounts = new Map<string, StatisticsWordCountValue>();
  for (const row of baselineRows) {
    addStatisticsWordCount(baselineCounts, {
      word: row.word,
      displayWord: row.display_word,
      count: row.total_count,
      lastSeenAt: row.last_seen_at,
    });
  }
  for (const batch of pendingBatches) {
    if (mergedBatches.has(batch.batch)) continue;
    for (const row of batch.words) addStatisticsWordCount(pendingCounts, row);
  }
  if (streamWord !== null) addStatisticsWordCount(fullStreamCounts, streamWord);

  const hiddenBefore = new Date(Date.now() - STATISTICS_WORD_RARE_HIDE_MILLISECONDS).toISOString();
  const count = calculateStatisticsWordCount(word, baselineCounts, pendingCounts, "total", hiddenBefore, fullStreamCounts);
  const ignoredWords = new Set(event.settings.ignoredWords.map(foldStatisticsWord));
  const language = await context.channelLanguage();
  const text = count.count === 0 || count.hiddenByRarity || ignoredWords.has(word)
    ? unknownWordReply(language, argument)
    : wordCommandReply(language, count.displayWord, streamIsLive, count.streamCount, count.totalCount);
  return {
    actions: [{ kind: "chat", text, replyToMessageId: messageId, automated: false }],
    diagnostics: [],
  };
};

const writeAbsoluteWindow = async (
  context: ModuleAlarmContext,
  window: ModuleStatisticsWindow,
): Promise<void> => {
  await context.DB.prepare(
    `INSERT INTO channel_statistics
       (channel_id, stream_id, window_start, messages, emotes, viewer_count, chatters, active_chatters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, window_start) DO UPDATE SET
       stream_id = excluded.stream_id,
       messages = MAX(channel_statistics.messages, excluded.messages),
       emotes = MAX(channel_statistics.emotes, excluded.emotes),
       viewer_count = excluded.viewer_count,
       chatters = excluded.chatters,
       active_chatters = excluded.active_chatters`,
  ).bind(
    context.channelId,
    window.streamId,
    window.windowStart,
    window.messages,
    window.emotes,
    window.viewerCount,
    window.chatters,
    window.activeChatters,
  ).run();
};

/** Merges one word bucket into the channel baseline in a single D1 batch. */
export const mergeStatisticsWordBatch = async (
  db: D1Database,
  channelId: string,
  streamId: string,
  batch: number,
  wordCounts: readonly {
    word: string;
    displayWord: string;
    count: number;
    lastSeenAt: string;
  }[],
  mergedAt: string,
): Promise<boolean> => {
  const countsByWord = new Map<string, {
    word: string;
    displayWord: string;
    count: number;
    lastSeenAt: string;
  }>();
  for (const entry of wordCounts) {
    const word = foldStatisticsWord(entry.word);
    if (word.length === 0 || !Number.isSafeInteger(entry.count) || entry.count <= 0) continue;
    const current = countsByWord.get(word) ?? {
      word,
      displayWord: entry.displayWord.length > 0 ? entry.displayWord : entry.word,
      count: 0,
      lastSeenAt: entry.lastSeenAt,
    };
    current.count += entry.count;
    if (current.lastSeenAt < entry.lastSeenAt) current.lastSeenAt = entry.lastSeenAt;
    countsByWord.set(word, current);
  }
  const topWords = [...countsByWord.values()]
    .sort((left, right) => right.count - left.count || (left.word < right.word ? -1 : left.word > right.word ? 1 : 0))
    .slice(0, STATISTICS_WORD_STREAM_MERGE_LIMIT);
  if (topWords.length === 0) return false;

  const foldStatements = await legacyStatisticsWordBaselineFoldStatements(db, channelId, mergedAt);

  const results = await db.batch([
    ...foldStatements,
    db.prepare(
      `INSERT OR IGNORE INTO channel_word_frequency_streams (channel_id, stream_id, batch, merged_at)
       VALUES (?, ?, ?, NULL)`,
    ).bind(channelId, streamId, batch),
    db.prepare(
      `INSERT INTO channel_word_frequency_baseline
         (channel_id, word, total_count, last_seen_at, display_word)
       SELECT ?, json_extract(value, '$.word'), CAST(json_extract(value, '$.count') AS INTEGER),
              json_extract(value, '$.lastSeenAt'), json_extract(value, '$.displayWord')
         FROM json_each(?)
        WHERE EXISTS (
          SELECT 1 FROM channel_word_frequency_streams
           WHERE channel_id = ? AND stream_id = ? AND batch = ? AND merged_at IS NULL
        )
       ON CONFLICT (channel_id, word) DO UPDATE SET
         total_count = channel_word_frequency_baseline.total_count + excluded.total_count,
         last_seen_at = MAX(channel_word_frequency_baseline.last_seen_at, excluded.last_seen_at),
         display_word = CASE WHEN channel_word_frequency_baseline.display_word = ''
                             THEN excluded.display_word ELSE channel_word_frequency_baseline.display_word END`,
    ).bind(channelId, JSON.stringify(topWords), channelId, streamId, batch),
    db.prepare(
      `DELETE FROM channel_word_frequency_baseline
        WHERE channel_id = ? AND word NOT IN (
          SELECT word FROM channel_word_frequency_baseline
           WHERE channel_id = ?
           ORDER BY total_count DESC, word ASC
           LIMIT ?
        )`,
    ).bind(channelId, channelId, STATISTICS_WORD_BASELINE_LIMIT),
    db.prepare(
      `UPDATE channel_word_frequency_streams SET merged_at = ?
        WHERE channel_id = ? AND stream_id = ? AND batch = ? AND merged_at IS NULL`,
    ).bind(mergedAt, channelId, streamId, batch),
    db.prepare(
      `SELECT 1 AS merged FROM channel_word_frequency_streams
        WHERE channel_id = ? AND stream_id = ? AND batch = ? AND merged_at IS NOT NULL`,
    ).bind(channelId, streamId, batch),
  ]);
  return (results.at(-1)?.results.length ?? 0) > 0;
};

interface LegacyWordRow {
  word: string;
  total_count: number;
  last_seen_at: string;
}

/** Builds the legacy fold steps so they commit atomically with the next baseline merge. */
const legacyStatisticsWordBaselineFoldStatements = async (
  db: D1Database,
  channelId: string,
  foldedAt: string,
): Promise<D1PreparedStatement[]> => {
  const marker = await db.prepare(
    "SELECT folded_at FROM channel_word_frequency_baseline_folded WHERE channel_id = ?",
  ).bind(channelId).first<{ folded_at: string | null }>();
  if (marker?.folded_at != null) return [];

  const existing = await db.prepare(
    `SELECT word, total_count, last_seen_at
       FROM channel_word_frequency_baseline WHERE channel_id = ?`,
  ).bind(channelId).all<LegacyWordRow>();
  const folded = new Map<string, {
    word: string;
    totalCount: number;
    lastSeenAt: string;
    displayWord: string;
    displayCount: number;
  }>();
  for (const row of existing.results) {
    const word = foldStatisticsWord(row.word);
    if (word.length === 0 || row.total_count <= 0) continue;
    const value = folded.get(word) ?? {
      word,
      totalCount: 0,
      lastSeenAt: row.last_seen_at,
      displayWord: row.word,
      displayCount: 0,
    };
    value.totalCount += row.total_count;
    if (value.lastSeenAt < row.last_seen_at) value.lastSeenAt = row.last_seen_at;
    if (row.total_count > value.displayCount ||
        row.total_count === value.displayCount && row.word < value.displayWord) {
      value.displayWord = row.word;
      value.displayCount = row.total_count;
    }
    folded.set(word, value);
  }
  const rows = [...folded.values()].map(({ word, totalCount, lastSeenAt, displayWord }) => ({
    word, totalCount, lastSeenAt, displayWord,
  }));
  return [
    db.prepare(
      "INSERT OR IGNORE INTO channel_word_frequency_baseline_folded (channel_id, folded_at) VALUES (?, NULL)",
    ).bind(channelId),
    db.prepare(
      `DELETE FROM channel_word_frequency_baseline WHERE channel_id = ? AND EXISTS (
        SELECT 1 FROM channel_word_frequency_baseline_folded WHERE channel_id = ? AND folded_at IS NULL
      )`,
    ).bind(channelId, channelId),
    db.prepare(
      `INSERT INTO channel_word_frequency_baseline
         (channel_id, word, total_count, last_seen_at, display_word)
       SELECT ?, json_extract(value, '$.word'), CAST(json_extract(value, '$.totalCount') AS INTEGER),
              json_extract(value, '$.lastSeenAt'), json_extract(value, '$.displayWord')
         FROM json_each(?)
        WHERE EXISTS (
          SELECT 1 FROM channel_word_frequency_baseline_folded WHERE channel_id = ? AND folded_at IS NULL
        )
       ON CONFLICT (channel_id, word) DO UPDATE SET
         total_count = excluded.total_count,
         last_seen_at = excluded.last_seen_at,
         display_word = excluded.display_word`,
    ).bind(channelId, JSON.stringify(rows), channelId),
    db.prepare(
      "UPDATE channel_word_frequency_baseline_folded SET folded_at = ? WHERE channel_id = ? AND folded_at IS NULL",
    ).bind(foldedAt, channelId),
  ];
};

const recordEmoteSpike = async (
  context: ModuleAlarmContext,
  window: ModuleStatisticsWindow,
): Promise<void> => {
  if (context.recordTimelineEvent === undefined) return;
  const previous = await context.DB.prepare(
    `SELECT emotes FROM channel_statistics
      WHERE channel_id = ? AND window_start < ?
      ORDER BY window_start DESC LIMIT ?`,
  ).bind(context.channelId, window.windowStart, EMOTE_SPIKE_BASELINE_WINDOWS)
    .all<{ emotes: number }>();
  if (previous.results.length === 0 || window.emotes < EMOTE_SPIKE_MINIMUM_COUNT) return;

  const counts = previous.results.map(({ emotes }) => emotes).sort((left, right) => left - right);
  const middle = Math.floor(counts.length / 2);
  const medianEmotes = counts.length % 2 === 0
    ? ((counts[middle - 1] ?? 0) + (counts[middle] ?? 0)) / 2
    : counts[middle] ?? 0;
  if (window.emotes < medianEmotes * EMOTE_SPIKE_MULTIPLIER) return;

  const windowEnd = Date.parse(window.windowStart) + STATISTICS_WINDOW_MILLISECONDS;
  if (!Number.isFinite(windowEnd)) return;
  const timelineEvent: ModuleTimelineEvent = {
    kind: "emote_spike",
    identity: window.windowStart,
    occurredAt: new Date(windowEnd).toISOString(),
    detail: {
      windowStart: window.windowStart,
      emotes: window.emotes,
      medianEmotes,
      baselineWindows: counts.length,
      minimumEmotes: EMOTE_SPIKE_MINIMUM_COUNT,
      multiplier: EMOTE_SPIKE_MULTIPLIER,
    },
  };
  await context.recordTimelineEvent(timelineEvent);
};

export const processStatisticsEvent = async (
  event: ModuleEvent,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType === "stream.online") {
    if (context.streamStateTransitionAccepted !== true) return emptyResult();
    const startedAt = textValue(event.payload.started_at);
    const startedAtMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
    if (!Number.isFinite(startedAtMs)) return emptyResult();
    const receivedAtMs = Date.parse(event.receivedAt);
    await context.scheduleAlarm(
      "window",
      "window",
      nextBoundary(Number.isFinite(receivedAtMs) ? receivedAtMs : startedAtMs),
    );
    return emptyResult();
  }
  if (event.subscriptionType === "stream.offline") {
    const streamId = context.streamSession?.streamId;
    if (context.streamStateTransitionAccepted === true) {
      if (streamId !== null && streamId !== undefined) {
        await context.statisticsChat?.markWordStreamEnded(streamId, event.eventSubTimestamp ?? event.receivedAt);
      }
      await context.scheduleAlarm("window", "window", nextBoundary(Date.now()));
    }
    return emptyResult();
  }
  if (event.subscriptionType === "channel.chat.message") {
    const settings = statisticsSettingsSchema.safeParse(event.settings);
    return settings.success
      ? await processStatisticsWordCommand({ ...event, settings: settings.data }, context)
      : emptyResult();
  }
  return emptyResult();
};

export const reconcileStatisticsSchedule = async (
  context: ModuleAlarmContext,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  if (reason !== "stream_state" || context.statisticsChat === undefined) return;
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  const now = Date.now();
  const [deadline, hasWindows, hasWordStreams, hasClipImports] = await Promise.all([
    context.getAlarmDeadline?.("window") ?? Promise.resolve(null),
    context.statisticsChat.hasWindows(),
    context.statisticsChat.hasWordStreams(),
    context.statisticsChat.hasClipImports(),
  ]);
  if (deadline !== null || stream?.state !== "online" && !hasWindows && !hasWordStreams && !hasClipImports) return;
  await context.schedule("window", nextBoundary(now));
};

const streamStartedAt = async (
  context: ModuleAlarmContext,
  pending: { streamId: string; startedAt: string | null },
): Promise<string | null> => {
  if (typeof pending.startedAt === "string" && Number.isFinite(Date.parse(pending.startedAt))) {
    return pending.startedAt;
  }
  const row = await context.DB.prepare(
    `SELECT MIN(window_start) AS started_at FROM channel_statistics
      WHERE channel_id = ? AND stream_id = ?`,
  ).bind(context.channelId, pending.streamId).first<{ started_at: string | null }>();
  return typeof row?.started_at === "string" && Number.isFinite(Date.parse(row.started_at))
    ? row.started_at
    : null;
};

const importReadyStreamClips = async (
  context: ModuleAlarmContext,
  now: number,
): Promise<void> => {
  const statisticsChat = context.statisticsChat;
  const recordTimelineEvent = context.recordTimelineEventStrict;
  if (statisticsChat === undefined || context.fetchStreamClips === undefined || recordTimelineEvent === undefined) return;
  for (const pending of await statisticsChat.listReadyClipImports(now)) {
    try {
      const startedAt = await streamStartedAt(context, pending);
      if (startedAt === null) continue;
      const clips = await context.fetchStreamClips(startedAt, pending.endedAt);
      if (clips === null) continue;
      for (const clip of clips) {
        await recordTimelineEvent({
          kind: "clip_created",
          identity: clip.clipId,
          occurredAt: clip.createdAt,
          detail: {
            clipId: clip.clipId,
            title: clip.title,
            createdAt: clip.createdAt,
            ...(clip.viewCount === undefined ? {} : { viewCount: clip.viewCount }),
            ...(clip.durationSeconds === undefined ? {} : { durationSeconds: clip.durationSeconds }),
          },
        });
      }
      await statisticsChat.completeClipImport(pending.streamId, pending.endedAt);
    } catch (error: unknown) {
      console.warn("Statistics clip import failed; the pending import will retry.", error);
    }
  }
};

/** Reads the stream state, advances the window clock and writes every completed dirty window. */
const flushCompletedWindows = async (
  context: ModuleAlarmContext,
  statisticsChat: NonNullable<ModuleAlarmContext["statisticsChat"]>,
  deadline: number,
): Promise<{
  streamIsOnline: boolean;
  streamState: "online" | "offline" | "unknown";
  streamId: string | null;
  writeFailure: unknown;
}> => {
  await statisticsChat.flushWordCounts();
  const stream = await context.DB.prepare(
    "SELECT state, stream_id, started_at FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<StoredStreamState>();
  const streamIsOnline = stream?.state === "online" && stream.started_at !== null;
  const streamState = stream?.state === "online" ? "online" : stream?.state === "offline" ? "offline" : "unknown";
  await statisticsChat.reconcileWordStreams(streamState, stream?.stream_id ?? null, Date.now());
  await statisticsChat.advanceToBoundary(deadline, streamIsOnline, stream?.stream_id ?? null);

  const boundaryWindowStart = new Date(deadline - STATISTICS_WINDOW_MILLISECONDS).toISOString();
  const boundaryWindow = streamIsOnline ? await statisticsChat.readWindow(boundaryWindowStart) : null;
  if (boundaryWindow !== null && !boundaryWindow.metricsSampled) {
    const [viewerCount, chatters] = await Promise.all([
      sampledCount(context.fetchViewerCount),
      sampledCount(context.fetchChattersTotal),
    ]);
    await statisticsChat.saveWindowMetrics(boundaryWindowStart, viewerCount, chatters);
  }

  let writeFailure: unknown;
  for (const windowStart of await statisticsChat.listDirtyCompletedWindows()) {
    const window = await statisticsChat.readWindow(windowStart);
    if (window === null) continue;
    try {
      await writeAbsoluteWindow(context, window);
      try {
        await recordEmoteSpike(context, window);
      } catch (error: unknown) {
        // The window is already persisted; a lost spike must not keep it dirty or block the reschedule.
        console.warn("Emote spike could not be evaluated.", error);
      }
      await statisticsChat.markWindowClean(windowStart, window.revision);
    } catch (error: unknown) {
      writeFailure ??= error;
    }
  }
  return { streamIsOnline, streamState, streamId: stream?.stream_id ?? null, writeFailure };
};

export const handleStatisticsWindowAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
): Promise<void> => {
  if (alarmKey !== "window") return;
  if (context.statisticsChat === undefined) throw new Error("Statistics chat storage is unavailable.");

  let outcome: Awaited<ReturnType<typeof flushCompletedWindows>> | undefined;
  let flushFailure: unknown;
  let flushFailed = false;
  try {
    outcome = await flushCompletedWindows(context, context.statisticsChat, deadline);
  } catch (error: unknown) {
    flushFailed = true;
    flushFailure = error;
  }
  // Age-based pruning must not depend on the state read or the D1 writes succeeding.
  const now = Date.now();
  let maintenanceFailure: unknown;
  try {
    await context.statisticsChat.pruneExpiredWindows(now);
  } catch (error: unknown) {
    maintenanceFailure ??= error;
  }
  try {
    await context.statisticsChat.pruneExpiredWordStreams(now);
  } catch (error: unknown) {
    maintenanceFailure ??= error;
  }
  try {
    await context.statisticsChat.pruneExpiredClipImports(now);
  } catch (error: unknown) {
    maintenanceFailure ??= error;
  }
  const [hasWindows, hasWordStreams, hasClipImports] = await Promise.all([
    context.statisticsChat.hasWindows(),
    context.statisticsChat.hasWordStreams(),
    context.statisticsChat.hasClipImports(),
  ]);
  if (flushFailed) {
    if (hasWindows || hasWordStreams || hasClipImports) {
      await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS);
    }
    if (flushFailure instanceof Error) throw flushFailure;
    throw new Error("Statistics state read failed.", { cause: flushFailure });
  }
  if (maintenanceFailure !== undefined) {
    if (outcome?.streamState === "online" || hasWindows || hasWordStreams || hasClipImports) {
      await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS);
    }
    if (maintenanceFailure instanceof Error) throw maintenanceFailure;
    throw new Error("Statistics retention pruning failed.", { cause: maintenanceFailure });
  }
  if (outcome === undefined) throw new Error("Statistics window alarm did not finish.");

  let wordMergeFailure: unknown;
  try {
    const idleBefore = now - STATISTICS_WORD_STREAM_IDLE_MILLISECONDS;
    const buckets = await context.statisticsChat.listMergeableWordBuckets(
      outcome.streamState,
      outcome.streamId,
      idleBefore,
    );
    const blockedStreams = new Set<string>();
    for (const bucket of buckets) {
      if (blockedStreams.has(bucket.streamId)) continue;
      try {
        const prepared = await context.statisticsChat.prepareWordBucketForMerge(
          bucket,
          outcome.streamState,
          outcome.streamId,
          idleBefore,
        );
        if (prepared === null || prepared.words.length === 0) continue;
        const merged = await mergeStatisticsWordBatch(
          context.DB,
          context.channelId,
          bucket.streamId,
          bucket.batch,
          prepared.words,
          new Date(now).toISOString(),
        );
        // A refused merge (stream turned live meanwhile) keeps the bucket for a later alarm and blocks
        // the stream's later batches so they cannot overtake it and reorder the capped baseline.
        if (merged) await context.statisticsChat.deleteWordBucket(bucket);
        else blockedStreams.add(bucket.streamId);
      } catch (error: unknown) {
        blockedStreams.add(bucket.streamId);
        wordMergeFailure ??= error;
      }
    }
  } catch (error: unknown) {
    wordMergeFailure ??= error;
  }

  await importReadyStreamClips(context, now);

  const pendingWordStreams = await context.statisticsChat.hasWordStreams();
  const pendingClipImports = await context.statisticsChat.hasClipImports();
  if (outcome.streamState === "online" || hasWindows || pendingWordStreams || pendingClipImports) {
    // The host retires an occurrence only if it is still the stored entry; scheduling the same key
    // also keeps D1 retries alive while the age-based pruning bound remains independent.
    await context.schedule("window", deadline + STATISTICS_WINDOW_MILLISECONDS);
  }

  if (outcome.writeFailure !== undefined) {
    if (outcome.writeFailure instanceof Error) throw outcome.writeFailure;
    throw new Error("Statistics window write failed.", { cause: outcome.writeFailure });
  }
  if (wordMergeFailure instanceof Error) throw wordMergeFailure;
  if (wordMergeFailure !== undefined) {
    throw new Error("Statistics word baseline merge failed.", { cause: wordMergeFailure });
  }
};
