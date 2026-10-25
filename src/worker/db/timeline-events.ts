import type { ModuleTimelineEvent } from "../../modules/contract";

const STREAM_DROP_WINDOW_MS = 10 * 60_000;

interface TimelineEventRow {
  event_key: string;
  occurred_at: string;
}

interface RelatedOnlineEventRow extends TimelineEventRow {
  stream_id: string | null;
}

const canonicalTimestamp = (value: string): string | null => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const currentStreamId = async (database: D1Database, channelId: string): Promise<string | null> => {
  const row = await database.prepare(
    "SELECT stream_id FROM channel_stream_state WHERE channel_id = ? AND state = 'online'",
  ).bind(channelId).first<{ stream_id: string | null }>();
  return row?.stream_id ?? null;
};

const insertTimelineRow = async (
  database: D1Database,
  channelId: string,
  eventKey: string,
  streamId: string | null,
  occurredAt: string,
  kind: ModuleTimelineEvent["kind"] | "stream_drop",
  detail: Readonly<Record<string, unknown>>,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_timeline_events (channel_id, event_key, stream_id, occurred_at, kind, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, event_key) DO NOTHING`,
  ).bind(channelId, eventKey, streamId, occurredAt, kind, JSON.stringify(detail)).run();
};

const relatedOnlineEvent = async (
  database: D1Database,
  channelId: string,
  comparison: "before" | "after",
  occurredAt: string,
): Promise<RelatedOnlineEventRow | null> => {
  if (comparison === "before") {
    return database.prepare(
      `SELECT event_key, stream_id, occurred_at
         FROM channel_timeline_events
        WHERE channel_id = ? AND kind = 'stream_online' AND occurred_at < ?
        ORDER BY occurred_at DESC LIMIT 1`,
    ).bind(channelId, occurredAt).first<RelatedOnlineEventRow>();
  }
  return database.prepare(
    `SELECT event_key, stream_id, occurred_at
       FROM channel_timeline_events
      WHERE channel_id = ? AND kind = 'stream_online' AND occurred_at > ?
      ORDER BY occurred_at ASC LIMIT 1`,
  ).bind(channelId, occurredAt).first<RelatedOnlineEventRow>();
};

const reconcileDrops = async (database: D1Database, channelId: string, around: string): Promise<void> => {
  const aroundMs = Date.parse(around);
  const offlineRows = await database.prepare(
    `SELECT event_key, occurred_at FROM channel_timeline_events
      WHERE channel_id = ? AND kind = 'stream_offline' AND occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at DESC`,
  ).bind(
    channelId,
    new Date(aroundMs - STREAM_DROP_WINDOW_MS).toISOString(),
    around,
  ).all<TimelineEventRow>();

  for (const offline of offlineRows.results) {
    const [previousOnline, recoveryOnline] = await Promise.all([
      relatedOnlineEvent(database, channelId, "before", offline.occurred_at),
      relatedOnlineEvent(database, channelId, "after", offline.occurred_at),
    ]);
    if (previousOnline === null || recoveryOnline === null || previousOnline.stream_id === null ||
        previousOnline.stream_id !== recoveryOnline.stream_id) continue;

    const gapMs = Date.parse(recoveryOnline.occurred_at) - Date.parse(offline.occurred_at);
    if (gapMs < 0 || gapMs > STREAM_DROP_WINDOW_MS) continue;
    await insertTimelineRow(
      database,
      channelId,
      `drop:${offline.event_key}:${recoveryOnline.event_key}`,
      recoveryOnline.stream_id,
      recoveryOnline.occurred_at,
      "stream_drop",
      { gapSeconds: Math.round(gapMs / 1_000) },
    );
  }
};

/** Writes an aggregate-only event once; lifecycle retries also reconcile a late drop pair. */
export const writeChannelTimelineEvent = async (
  database: D1Database,
  channelId: string,
  event: ModuleTimelineEvent,
): Promise<void> => {
  const occurredAt = canonicalTimestamp(event.occurredAt);
  if (occurredAt === null || event.identity.trim().length === 0) return;
  const streamId = event.streamId === undefined ? await currentStreamId(database, channelId) : event.streamId;
  const eventKey = `${event.kind}:${event.identity}`;
  await insertTimelineRow(database, channelId, eventKey, streamId, occurredAt, event.kind, event.detail);
  if (event.kind === "stream_online" || event.kind === "stream_offline") {
    await reconcileDrops(database, channelId, occurredAt);
  }
};

/** Reads the most recent known title transition before an occurrence for old → new details. */
export const readPreviousTimelineTitle = async (
  database: D1Database,
  channelId: string,
  before: string,
): Promise<string | null> => {
  const row = await database.prepare(
    `SELECT json_extract(detail_json, '$.newTitle') AS title
       FROM channel_timeline_events
      WHERE channel_id = ? AND kind = 'title_change' AND occurred_at < ?
      ORDER BY occurred_at DESC LIMIT 1`,
  ).bind(channelId, before).first<{ title: string | null }>();
  return row?.title ?? null;
};

/** Reads the last timeline category transition before an occurrence. */
export const readPreviousTimelineCategory = async (
  database: D1Database,
  channelId: string,
  before: string,
): Promise<{ id: string | null; name: string | null } | null> => {
  const row = await database.prepare(
    `SELECT json_extract(detail_json, '$.newCategory.id') AS id,
            json_extract(detail_json, '$.newCategory.name') AS name
       FROM channel_timeline_events
      WHERE channel_id = ? AND kind = 'category_change' AND occurred_at < ?
      ORDER BY occurred_at DESC LIMIT 1`,
  ).bind(channelId, before).first<{ id: string | null; name: string | null }>();
  return row === null ? null : { id: row.id ?? null, name: row.name ?? null };
};
