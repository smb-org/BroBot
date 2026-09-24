import { describe, expect, it } from "vitest";

import { readChannelControls, readDispatchChannelState, setChannelControl } from "../../src/worker/db/channel-controls";
import { writeEventSubStreamState, writeHelixStreamStateIfUnknown } from "../../src/worker/db/stream-state";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-23T09:00:00.000Z";
const actor = { userId: "operator-1", sessionId: "session-operator-1" };

const seedOperator = async (database: TestD1Database): Promise<void> => {
  await insertChannel(database, "kanal-a");
  await insertLoginIdentityAndSession(database, actor.userId);
  await insertMember(database, "kanal-a", actor.userId, "operator");
};

describe("channel controls", () => {
  it("preserves concurrent mute and pause writes and audits each requested control", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const db = database as unknown as D1Database;
      const [mute, pause] = await Promise.all([
        setChannelControl(db, actor, "kanal-a", "mute", "until_stream_end", NOW),
        setChannelControl(db, actor, "kanal-a", "pause", "1h", NOW),
      ]);

      expect(mute.outcome).toBe("changed");
      expect(pause.outcome).toBe("changed");
      await expect(readChannelControls(db, "kanal-a", NOW)).resolves.toEqual({
        mute: { active: false, pending: true, until: null, mode: "until_stream_end" },
        pause: { active: true, until: "2026-09-23T10:00:00.000Z", mode: "timed" },
      });
      const auditRows = await database.prepare(
        "SELECT action, before_json, after_json FROM audit_log ORDER BY rowid",
      ).all<{ action: string; before_json: string; after_json: string }>();
      expect(auditRows.results).toEqual([
        {
          action: "channel.mute.enabled",
          before_json: JSON.stringify({ active: false, mode: null, until: null }),
          after_json: JSON.stringify({ active: true, mode: "until_stream_end", until: null }),
        },
        {
          action: "channel.pause.enabled",
          before_json: JSON.stringify({ active: false, mode: null, until: null }),
          after_json: JSON.stringify({ active: true, mode: "timed", until: "2026-09-23T10:00:00.000Z" }),
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("expires timed mute and pause from fresh reads and audits member toggles", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const mute = await setChannelControl(database as unknown as D1Database, actor, "kanal-a", "mute", "15m", NOW);
      const pause = await setChannelControl(database as unknown as D1Database, actor, "kanal-a", "pause", "1h", NOW);

      expect(mute.controls.mute).toEqual({ active: true, until: "2026-09-23T09:15:00.000Z", mode: "timed" });
      expect(pause.controls.pause).toEqual({ active: true, until: "2026-09-23T10:00:00.000Z", mode: "timed" });
      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", "2026-09-23T09:14:59.999Z"))
        .resolves.toMatchObject({ mute: { active: true }, pause: { active: true } });
      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", "2026-09-23T09:15:00.000Z"))
        .resolves.toMatchObject({ mute: { active: false }, pause: { active: true } });
      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", "2026-09-23T10:00:00.000Z"))
        .resolves.toEqual({
          mute: { active: false, until: null, mode: null },
          pause: { active: false, until: null, mode: null },
        });

      const audits = await database.prepare("SELECT actor_user_id, action, actor_kind FROM audit_log ORDER BY created_at, action")
        .all<{ actor_user_id: string; action: string; actor_kind: string }>();
      expect(audits.results).toEqual([
        { actor_user_id: actor.userId, action: "channel.mute.enabled", actor_kind: "member" },
        { actor_user_id: actor.userId, action: "channel.pause.enabled", actor_kind: "member" },
      ]);
    } finally {
      database.close();
    }
  });

  it("stores a live stream session and derives activity from the current session", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const db = database as unknown as D1Database;
      const startedAt = "2026-09-23T08:00:00.000Z";
      await writeEventSubStreamState(db, "kanal-a", "online", NOW, startedAt);
      await setChannelControl(db, actor, "kanal-a", "mute", "until_stream_end", NOW);

      await expect(database.prepare(
        "SELECT mute_until_stream_end, mute_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ mute_until_stream_end: 1, mute_stream_started_at: startedAt });
      await expect(readDispatchChannelState(db, "kanal-a", NOW)).resolves.toMatchObject({
        controls: { mute: { active: true, mode: "until_stream_end" } },
      });

      await writeEventSubStreamState(db, "kanal-a", "offline", "2026-09-23T10:00:00.000Z", null);
      await expect(readChannelControls(db, "kanal-a", "2026-09-23T10:00:00.000Z")).resolves.toMatchObject({
        mute: { active: false },
      });
      await writeEventSubStreamState(db, "kanal-a", "online", "2026-09-23T11:00:00.000Z", "2026-09-23T10:59:00.000Z");
      await expect(readDispatchChannelState(db, "kanal-a", "2026-09-23T11:00:00.000Z")).resolves.toMatchObject({
        controls: { mute: { active: false, mode: null } },
      });
      await expect(database.prepare(
        "SELECT muted, mute_until_stream_end, mute_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ muted: 1, mute_until_stream_end: 1, mute_stream_started_at: startedAt });
    } finally {
      database.close();
    }
  });

  it("keeps a Helix-bound control active for the same EventSub stream id despite timestamp formatting", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const db = database as unknown as D1Database;
      const streamId = "twitch-stream-123";
      await writeHelixStreamStateIfUnknown(
        db, "kanal-a", "online", "2026-09-23T09:00:05.000Z", "2026-09-23T09:00:00Z", streamId,
      );
      await setChannelControl(db, actor, "kanal-a", "mute", "until_stream_end", NOW);

      await expect(writeEventSubStreamState(
        db, "kanal-a", "online", "2026-09-23T09:01:00.000Z", "2026-09-23T09:00:00.000Z", streamId,
      )).resolves.toBe("written");

      await expect(database.prepare(
        `SELECT muted, mute_stream_started_at, mute_stream_id
           FROM channel_controls WHERE channel_id = 'kanal-a'`,
      ).first()).resolves.toEqual({
        muted: 1, mute_stream_started_at: "2026-09-23T09:00:00Z", mute_stream_id: streamId,
      });
      await expect(readDispatchChannelState(db, "kanal-a", "2026-09-23T09:01:01.000Z")).resolves.toMatchObject({
        controls: { mute: { active: true, mode: "until_stream_end" } },
      });
    } finally {
      database.close();
    }
  });

  it("normalizes timestamp-only session identity for rows that predate stream ids", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const helixStart = "2026-09-23T08:00:00Z";
      const eventSubSpelling = "2026-09-23T08:00:00.000Z";
      await database.prepare(
        `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
         VALUES ('kanal-a', 'online', ?, 'helix', ?)`,
      ).bind(NOW, helixStart).run();
      await database.prepare(
        `INSERT INTO channel_controls
          (channel_id, muted, mute_until_stream_end, mute_stream_started_at, updated_at)
         VALUES ('kanal-a', 1, 1, ?, ?)`,
      ).bind(eventSubSpelling, NOW).run();

      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", NOW)).resolves.toMatchObject({
        mute: { active: true, mode: "until_stream_end" },
      });
    } finally {
      database.close();
    }
  });

  it("keeps an offline control pending for the next stream and ends it with that session", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const db = database as unknown as D1Database;
      await setChannelControl(db, actor, "kanal-a", "pause", "until_stream_end", NOW);

      await expect(readChannelControls(db, "kanal-a", NOW)).resolves.toMatchObject({
        pause: { active: false, pending: true, mode: "until_stream_end" },
      });
      await expect(readDispatchChannelState(db, "kanal-a", NOW)).resolves.toMatchObject({
        controls: { pause: { active: false, mode: null } },
      });
      await expect(database.prepare(
        "SELECT pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ pause_stream_started_at: null });

      const startedAt = "2026-09-23T09:30:00.000Z";
      await writeEventSubStreamState(db, "kanal-a", "online", "2026-09-23T09:31:00.000Z", startedAt);
      await expect(database.prepare(
        "SELECT pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ pause_stream_started_at: startedAt });
      await expect(readDispatchChannelState(db, "kanal-a", "2026-09-23T09:31:00.000Z")).resolves.toMatchObject({
        controls: { pause: { active: true, mode: "until_stream_end" } },
      });

      await writeEventSubStreamState(db, "kanal-a", "offline", "2026-09-23T10:30:00.000Z", null);
      await expect(readDispatchChannelState(db, "kanal-a", "2026-09-23T10:30:00.000Z")).resolves.toMatchObject({
        controls: { pause: { active: false, mode: null } },
      });
      await writeEventSubStreamState(db, "kanal-a", "offline", "2026-09-23T10:30:00.000Z", null);
      await writeEventSubStreamState(db, "kanal-a", "online", "2026-09-23T10:00:00.000Z", "2026-09-23T09:55:00.000Z");
      await expect(database.prepare(
        "SELECT state, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "offline", started_at: null });
      await expect(database.prepare(
        "SELECT paused, pause_until_stream_end, pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ paused: 1, pause_until_stream_end: 1, pause_stream_started_at: startedAt });
    } finally {
      database.close();
    }
  });

  it("rejects an offline event that predates the live session start", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      await database.prepare(
        `INSERT INTO channel_stream_state
          (channel_id, state, changed_at, source, started_at, checked_at)
         VALUES ('kanal-a', 'online', '2026-09-23T10:04:00.000Z', 'helix', '2026-09-23T10:03:00.000Z', '2026-09-23T10:04:00.000Z')`,
      ).run();

      await expect(writeEventSubStreamState(
        database as unknown as D1Database,
        "kanal-a",
        "offline",
        "2026-09-23T10:00:00.000Z",
        null,
      )).resolves.toBe("stale_offline");
      await expect(database.prepare(
        "SELECT state, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", started_at: "2026-09-23T10:03:00.000Z" });
    } finally {
      database.close();
    }
  });

  it("accepts an offline event newer than an online observation with no recorded start", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      await database.prepare(
        `INSERT INTO channel_stream_state
          (channel_id, state, changed_at, source, started_at, checked_at)
         VALUES ('kanal-a', 'online', '2026-09-23T09:00:00.000Z', 'eventsub', NULL, '2026-09-23T09:00:00.000Z')`,
      ).run();

      await expect(writeEventSubStreamState(
        database as unknown as D1Database,
        "kanal-a",
        "offline",
        "2026-09-23T10:00:00.000Z",
        null,
      )).resolves.toBe("written");
      await expect(database.prepare(
        "SELECT state, changed_at, source, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({
        state: "offline",
        changed_at: "2026-09-23T10:00:00.000Z",
        source: "eventsub",
        started_at: null,
      });
    } finally {
      database.close();
    }
  });

  it("orders EventSub timestamps at full sub-millisecond precision and keeps the first exact tie", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const db = database as unknown as D1Database;
      const later = "2026-09-23T10:00:00.1234Z";
      await expect(writeEventSubStreamState(db, "kanal-a", "offline", later, null)).resolves.toBe("written");
      await expect(writeEventSubStreamState(db, "kanal-a", "online", "2026-09-23T10:00:00.1231Z", "2026-09-23T10:00:00.1000Z"))
        .resolves.toBe("superseded");
      await expect(writeEventSubStreamState(db, "kanal-a", "online", later, "2026-09-23T10:00:00.1000Z"))
        .resolves.toBe("superseded");

      await expect(database.prepare(
        "SELECT state, eventsub_changed_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "offline", eventsub_changed_at: later });
    } finally {
      database.close();
    }
  });

  it("rejects an online event for an older session after Helix records the current live session", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const db = database as unknown as D1Database;
      const currentStartedAt = "2026-09-23T11:00:00.000Z";
      await writeHelixStreamStateIfUnknown(
        db,
        "kanal-a",
        "online",
        "2026-09-23T11:30:00.000Z",
        currentStartedAt,
      );
      await setChannelControl(db, actor, "kanal-a", "pause", "until_stream_end", NOW);

      await expect(writeEventSubStreamState(
        db,
        "kanal-a",
        "online",
        NOW,
        "2026-09-23T09:00:00.000Z",
      )).resolves.toBe("superseded");
      await expect(database.prepare(
        "SELECT state, source, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", source: "helix", started_at: currentStartedAt });
      await expect(database.prepare(
        "SELECT paused, pause_until_stream_end, pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({
        paused: 1,
        pause_until_stream_end: 1,
        pause_stream_started_at: currentStartedAt,
      });
      await expect(readDispatchChannelState(db, "kanal-a", NOW)).resolves.toMatchObject({
        controls: { pause: { active: true, mode: "until_stream_end" } },
      });
    } finally {
      database.close();
    }
  });
});
