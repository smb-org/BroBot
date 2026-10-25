import type { ModuleTimelineEvent } from "../../modules/contract";

const canonicalTimestamp = (value: string): string | null => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const contentHash = async (detail: Readonly<Record<string, unknown>>): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(detail)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const naturalEventKey = async (event: ModuleTimelineEvent, occurredAt: string): Promise<string | null> => {
  if (event.kind === "stream_online") return `stream_online:${occurredAt}:${event.streamId ?? ""}`;
  if (event.kind === "stream_offline") return `stream_offline:${occurredAt}`;
  if (event.kind === "channel_metadata") return `channel_metadata:${occurredAt}:${await contentHash(event.detail)}`;
  if (event.identity.trim().length === 0) return null;
  return `${event.kind}:${event.identity}`;
};

const insertTimelineRow = async (
  database: D1Database,
  channelId: string,
  eventKey: string,
  streamId: string | null,
  occurredAt: string,
  kind: ModuleTimelineEvent["kind"],
  detail: Readonly<Record<string, unknown>>,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_timeline_events (channel_id, event_key, stream_id, occurred_at, kind, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, event_key) DO NOTHING`,
  ).bind(channelId, eventKey, streamId, occurredAt, kind, JSON.stringify(detail)).run();
};

/** Writes an aggregate-only observation; timeline failures never affect event processing. */
export const writeChannelTimelineEvent = async (
  database: D1Database,
  channelId: string,
  event: ModuleTimelineEvent,
): Promise<void> => {
  try {
    const occurredAt = canonicalTimestamp(event.occurredAt);
    if (occurredAt === null) return;
    const eventKey = await naturalEventKey(event, occurredAt);
    if (eventKey === null) return;
    const streamId = event.kind === "stream_online" ? event.streamId : null;
    await insertTimelineRow(database, channelId, eventKey, streamId, occurredAt, event.kind, event.detail);
  } catch (error: unknown) {
    console.warn("Channel timeline event could not be recorded.", error);
  }
};
