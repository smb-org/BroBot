import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { listChannelIdsNeedingStreamStateRefresh } from "../../src/worker/db/channels";
import { lookupAndRefreshStreamState, maintainStreamStates } from "../../src/worker/stream-state-lookup";
import { readDispatchChannelState, readChannelControls, setChannelControl } from "../../src/worker/db/channel-controls";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const NOW = "2026-09-23T12:00:00.000Z";
const STALE = "2026-09-23T11:49:00.000Z"; // 11 minutes before NOW -- past the 10-minute Helix TTL
const FRESH = "2026-09-23T11:55:00.000Z"; // 5 minutes before NOW -- inside the TTL
const keyRing = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const environment = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: keyRing,
} as unknown as Env);

const withAppToken = async (database: TestD1Database): Promise<void> => {
  await insertAppAccessToken(
    database,
    await encryptJson({ token: "app-token" }, parseKeyRing(keyRing)),
    "2099-09-21T00:00:00.000Z",
    NOW,
    NOW,
  );
};

const insertStreamState = async (
  database: TestD1Database,
  channelId: string,
  state: "online" | "offline",
  changedAt: string,
  source: "eventsub" | "helix",
  startedAt: string | null = null,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, state, changedAt, source, startedAt).run();
};

const insertStreamEventSubCoverage = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO eventsub_subscriptions
      (channel_id, subscription_type, subscription_id, status, updated_at)
     VALUES (?, 'stream.online', ?, 'enabled', ?), (?, 'stream.offline', ?, 'enabled', ?)`,
  ).bind(channelId, `online-${channelId}`, NOW, channelId, `offline-${channelId}`, NOW).run();
};

// `mockImplementation`, not `mockResolvedValue` with one shared `Response`:
// a `Response` body can only be read once, and every test here that calls
// the fetcher more than once (the cron loop, a refresh) needs a fresh one.
const helixResponse = (online: boolean, startedAt: string | null = null) => vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
  new Response(JSON.stringify({ data: online ? [{ id: "live-1", ...(startedAt === null ? {} : { started_at: startedAt }) }] : [] }), { status: 200 }),
));

const rateLimitedResponse = () => vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
  new Response(JSON.stringify({}), { status: 429 }),
));

/** Simulates an EventSub transition queued immediately after the Helix write. */
const databaseWithStreamTransitionAfterRefresh = (database: TestD1Database): D1Database => {
  let injected = false;
  const injectTransition = async (): Promise<void> => {
    if (injected) return;
    injected = true;
    const eventAt = "2026-09-23T12:00:01.000Z";
    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'online', changed_at = ?, source = 'eventsub', started_at = ?, checked_at = ?, eventsub_changed_at = ?
        WHERE channel_id = 'kanal-a'`,
    ).bind(eventAt, eventAt, eventAt, eventAt).run();
    await database.prepare(
      `UPDATE channel_controls
          SET muted = 1, mute_until_stream_end = 1,
              mute_stream_started_at = ?, paused = 1, pause_until_stream_end = 1,
              pause_stream_started_at = ?, updated_at = ?
        WHERE channel_id = 'kanal-a'`,
    ).bind(eventAt, eventAt, eventAt).run();
  };
  const db = {
    prepare(sql: string): D1PreparedStatement {
      const statement = database.prepare(sql);
      const wrapped: D1PreparedStatement = new Proxy(statement as unknown as D1PreparedStatement, {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) => {
              Reflect.apply(Reflect.get(target, "bind", target) as (...args: unknown[]) => unknown, target, values);
              return wrapped;
            };
          }
          if (property === "run") {
            return async (...values: unknown[]) => {
              const result: unknown = await Reflect.apply(Reflect.get(target, "run", target) as (...args: unknown[]) => unknown, target, values);
              if (sql.includes("UPDATE channel_stream_state")) await injectTransition();
              return result;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      return wrapped;
    },
    async batch(statements: D1PreparedStatement[]) {
      const results = await database.batch(statements as unknown as TestPreparedStatement[]);
      await injectTransition();
      return results;
    },
  };
  return db as unknown as D1Database;
};

describe("lookupAndRefreshStreamState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("looks up Helix and stores the result, with the real stream start, when no row exists", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await withAppToken(database);
      const fetcher = helixResponse(true, "2026-09-23T09:00:00.000Z");

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result).toEqual({ state: "online", startedAt: "2026-09-23T09:00:00.000Z", rateLimited: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(database.prepare(
        "SELECT state, source, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", source: "helix", started_at: "2026-09-23T09:00:00.000Z" });
    } finally {
      database.close();
    }
  });

  it("resets resettable variables on a Helix offline-to-online transition", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "offline", STALE, "helix");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, value, reset_on_stream_start, created_at, updated_at)
         VALUES ('kanal-a', 'score', 42, 1, ?, ?)`,
      ).bind(NOW, NOW).run();
      await withAppToken(database);

      const startedAt = "2026-09-23T11:59:00.000Z";
      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, helixResponse(true, startedAt));

      expect(result).toMatchObject({ state: "online", startedAt });
      await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
        .resolves.toEqual({ value: 0 });
      await expect(database.prepare("SELECT started_at FROM channel_variable_stream_resets WHERE channel_id = 'kanal-a'").first())
        .resolves.toEqual({ started_at: startedAt });
    } finally {
      database.close();
    }
  });

  it("does not call Helix when a fresh EventSub row has active stream coverage", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "offline", NOW, "eventsub");
      await insertStreamEventSubCoverage(database, "kanal-a");
      const fetcher = vi.fn<typeof fetch>();

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result.state).toBe("offline");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("lets a concurrent EventSub write win over its own Helix result on a first lookup", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await withAppToken(database);
      // A real EventSub delivery slips in between this call's read and its
      // write -- `writeHelixStreamStateIfUnknown`'s `ON CONFLICT DO NOTHING`
      // must not clobber it.
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        await insertStreamState(database, "kanal-a", "online", NOW, "eventsub");
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result.state).toBe("online");
      await expect(database.prepare(
        "SELECT state, changed_at, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", changed_at: NOW, source: "eventsub" });
    } finally {
      database.close();
    }
  });

  it("refreshes a stale row instead of returning it forever (#178)", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "offline", STALE, "helix");
      await withAppToken(database);
      const fetcher = helixResponse(true, "2026-09-23T11:58:00.000Z");

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result).toEqual({ state: "online", startedAt: "2026-09-23T11:58:00.000Z", rateLimited: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(database.prepare(
        "SELECT state, source, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", source: "helix", started_at: "2026-09-23T11:58:00.000Z" });
    } finally {
      database.close();
    }
  });

  it("refreshes a stale EventSub row's timestamp and missing live start when Helix confirms its state", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "online", STALE, "eventsub");
      await insertStreamEventSubCoverage(database, "kanal-a");
      await withAppToken(database);

      const result = await lookupAndRefreshStreamState(
        environment(database),
        "kanal-a",
        NOW,
        helixResponse(true, "2026-09-23T09:00:00.000Z"),
      );

      expect(result).toEqual({ state: "online", startedAt: "2026-09-23T09:00:00.000Z", rateLimited: false });
      await expect(database.prepare(
        "SELECT state, source, changed_at, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({
        state: "online", source: "helix", changed_at: NOW, started_at: "2026-09-23T09:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("adopts migrated legacy live controls when Helix resolves the same current session", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "online", STALE, "helix", "__legacy_current_live_session__");
      await database.prepare(
        `INSERT INTO channel_controls
          (channel_id, muted, mute_until_stream_end, mute_stream_started_at, updated_at)
         VALUES ('kanal-a', 1, 1, '__legacy_current_live_session__', ?)`,
      ).bind(STALE).run();
      await withAppToken(database);
      const startedAt = "2026-09-23T09:00:00.000Z";

      const result = await lookupAndRefreshStreamState(
        environment(database),
        "kanal-a",
        NOW,
        helixResponse(true, startedAt),
      );

      expect(result).toEqual({ state: "online", startedAt, rateLimited: false });
      await expect(database.prepare(
        "SELECT mute_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ mute_stream_started_at: startedAt });
    } finally {
      database.close();
    }
  });

  it("corrects a missed EventSub transition after the stale row's coverage has been restored", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "online", STALE, "eventsub", "2026-09-23T09:00:00.000Z");
      await insertStreamEventSubCoverage(database, "kanal-a");
      await database.prepare("DELETE FROM eventsub_subscriptions WHERE channel_id = 'kanal-a'").run();
      // The offline transition is missed while subscriptions are absent.
      await insertStreamEventSubCoverage(database, "kanal-a");
      await withAppToken(database);
      const fetcher = helixResponse(false);

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result).toEqual({ state: "offline", startedAt: null, rateLimited: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(database.prepare(
        "SELECT state, source, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "offline", source: "helix", started_at: null });
    } finally {
      database.close();
    }
  });

  it("does not overwrite a newer EventSub write while its stale row is being refreshed", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "offline", STALE, "eventsub");
      await withAppToken(database);
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        await database.prepare(
          `UPDATE channel_stream_state
              SET state = 'online', changed_at = ?, source = 'eventsub', started_at = ?
            WHERE channel_id = 'kanal-a'`,
        ).bind("2026-09-23T12:00:01.000Z", "2026-09-23T11:59:00.000Z").run();
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result).toEqual({ state: "online", startedAt: "2026-09-23T11:59:00.000Z", rateLimited: false });
      await expect(database.prepare(
        "SELECT state, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", source: "eventsub" });
    } finally {
      database.close();
    }
  });

  it("keeps a new stream control when an EventSub transition lands after the Helix batch", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "online", STALE, "helix", "2026-09-23T09:00:00.000Z");
      await database.prepare(
        `INSERT INTO channel_controls
          (channel_id, muted, muted_until, mute_until_stream_end,
           paused, paused_until, pause_until_stream_end, updated_at)
         VALUES ('kanal-a', 1, NULL, 1, 1, NULL, 1, ?)`,
      ).bind(STALE).run();
      await withAppToken(database);

      const result = await lookupAndRefreshStreamState(
        { ...environment(database), DB: databaseWithStreamTransitionAfterRefresh(database) },
        "kanal-a",
        NOW,
        helixResponse(false),
      );

      expect(result.state).toBe("online");
      await expect(database.prepare(
        "SELECT state, source, changed_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({
        state: "online", source: "eventsub", changed_at: "2026-09-23T12:00:01.000Z",
      });
      await expect(database.prepare(
        `SELECT muted, mute_until_stream_end, paused, pause_until_stream_end, updated_at
           FROM channel_controls WHERE channel_id = 'kanal-a'`,
      ).first()).resolves.toEqual({
        muted: 1, mute_until_stream_end: 1, paused: 1, pause_until_stream_end: 1, updated_at: "2026-09-23T12:00:01.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("keeps controls stored after a Helix offline transition and derives them inactive", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "online", STALE, "helix", "2026-09-23T09:00:00.000Z");
      await database.prepare(
        `INSERT INTO channel_controls
          (channel_id, muted, muted_until, mute_until_stream_end, mute_stream_started_at,
           paused, paused_until, pause_until_stream_end, pause_stream_started_at, updated_at)
         VALUES ('kanal-a', 1, NULL, 1, '2026-09-23T09:00:00.000Z', 1, NULL, 1, '2026-09-23T09:00:00.000Z', ?)`,
      ).bind(STALE).run();
      await withAppToken(database);

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, helixResponse(false));

      expect(result.state).toBe("offline");
      await expect(database.prepare(
        `SELECT muted, mute_until_stream_end, mute_stream_started_at,
                paused, pause_until_stream_end, pause_stream_started_at, updated_at
           FROM channel_controls WHERE channel_id = 'kanal-a'`,
      ).first()).resolves.toEqual({
        muted: 1, mute_until_stream_end: 1, mute_stream_started_at: "2026-09-23T09:00:00.000Z",
        paused: 1, pause_until_stream_end: 1, pause_stream_started_at: "2026-09-23T09:00:00.000Z", updated_at: STALE,
      });
      await expect(readDispatchChannelState(database as unknown as D1Database, "kanal-a", NOW)).resolves.toMatchObject({
        controls: { mute: { active: false }, pause: { active: false } },
      });
    } finally {
      database.close();
    }
  });

  it("restores a stream control after a brief false Helix offline observation", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const startedAt = "2026-09-23T09:00:00.000Z";
      await insertStreamState(database, "kanal-a", "online", STALE, "helix", startedAt);
      await database.prepare(
        `INSERT INTO channel_controls
          (channel_id, muted, mute_until_stream_end, mute_stream_started_at, updated_at)
         VALUES ('kanal-a', 1, 1, ?, ?)`,
      ).bind(startedAt, STALE).run();
      await withAppToken(database);

      await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, helixResponse(false));
      await expect(database.prepare(
        "SELECT muted, mute_until_stream_end, mute_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ muted: 1, mute_until_stream_end: 1, mute_stream_started_at: startedAt });
      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", NOW)).resolves.toMatchObject({
        mute: { active: false },
      });

      const correctionAt = "2026-09-23T12:11:00.000Z";
      await lookupAndRefreshStreamState(
        environment(database),
        "kanal-a",
        correctionAt,
        helixResponse(true, startedAt),
      );
      await expect(readDispatchChannelState(database as unknown as D1Database, "kanal-a", correctionAt)).resolves.toMatchObject({
        controls: { mute: { active: true, mode: "until_stream_end" } },
      });
    } finally {
      database.close();
    }
  });

  it("deactivates an old session's control when a restart happens between polls", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      const oldStartedAt = "2026-09-23T09:00:00.000Z";
      const newStartedAt = "2026-09-23T11:59:00.000Z";
      await insertStreamState(database, "kanal-a", "online", STALE, "helix", oldStartedAt);
      await database.prepare(
        `INSERT INTO channel_controls
          (channel_id, paused, pause_until_stream_end, pause_stream_started_at, updated_at)
         VALUES ('kanal-a', 1, 1, ?, ?)`,
      ).bind(oldStartedAt, STALE).run();
      await withAppToken(database);

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, helixResponse(true, newStartedAt));

      expect(result).toMatchObject({ state: "online", startedAt: newStartedAt });
      await expect(readDispatchChannelState(database as unknown as D1Database, "kanal-a", NOW)).resolves.toMatchObject({
        controls: { pause: { active: false, mode: null } },
      });
      await expect(database.prepare(
        "SELECT paused, pause_until_stream_end, pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ paused: 1, pause_until_stream_end: 1, pause_stream_started_at: oldStartedAt });
    } finally {
      database.close();
    }
  });

  it("keeps a control set while the hourly Helix tick is running", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "operator-1");
      await insertMember(database, "kanal-a", "operator-1", "operator");
      const startedAt = "2026-09-23T09:00:00.000Z";
      await insertStreamState(database, "kanal-a", "online", STALE, "helix", startedAt);
      await withAppToken(database);
      const db = database as unknown as D1Database;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        await setChannelControl(
          db,
          { userId: "operator-1", sessionId: "session-operator-1" },
          "kanal-a",
          "mute",
          "until_stream_end",
          NOW,
        );
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      await expect(database.prepare(
        "SELECT muted, mute_until_stream_end, mute_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ muted: 1, mute_until_stream_end: 1, mute_stream_started_at: startedAt });
      await expect(readChannelControls(db, "kanal-a", NOW)).resolves.toMatchObject({ mute: { active: false } });
    } finally {
      database.close();
    }
  });

  it("does not refresh a Helix-sourced row that hasn't gone stale yet", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "offline", FRESH, "helix");
      const fetcher = vi.fn<typeof fetch>();

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result.state).toBe("offline");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("never overwrites a newer EventSub row when refreshing a stale Helix row (#178)", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "offline", STALE, "helix");
      await insertStreamEventSubCoverage(database, "kanal-a");
      await withAppToken(database);
      // A newer EventSub transition lands while this stale refresh is in flight.
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        await database.prepare(
          `UPDATE channel_stream_state SET state = 'online', changed_at = ?, source = 'eventsub', started_at = ?
            WHERE channel_id = 'kanal-a'`,
        ).bind("2026-09-23T12:00:01.000Z", "2026-09-23T11:59:00.000Z").run();
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result).toEqual({ state: "online", startedAt: "2026-09-23T11:59:00.000Z", rateLimited: false });
      await expect(database.prepare(
        "SELECT state, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", source: "eventsub" });
    } finally {
      database.close();
    }
  });

  it("propagates a Helix 429 as rate-limited without touching the stored row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "offline", STALE, "helix");
      await withAppToken(database);
      const fetcher = rateLimitedResponse();

      const result = await lookupAndRefreshStreamState(environment(database), "kanal-a", NOW, fetcher);

      expect(result).toEqual({ state: "offline", startedAt: null, rateLimited: true });
      await expect(database.prepare(
        "SELECT state, source, changed_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "offline", source: "helix", changed_at: STALE });
    } finally {
      database.close();
    }
  });
});

describe("listChannelIdsNeedingStreamStateRefresh", () => {
  it("includes missing and stale rows of either source, excluding fresh rows", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-missing");
      await insertChannel(database, "kanal-stale-helix");
      await insertChannel(database, "kanal-fresh-helix");
      await insertChannel(database, "kanal-eventsub");
      await insertChannel(database, "kanal-uncovered-eventsub");
      await insertStreamState(database, "kanal-stale-helix", "offline", STALE, "helix");
      await insertStreamState(database, "kanal-fresh-helix", "offline", FRESH, "helix");
      await insertStreamState(database, "kanal-eventsub", "offline", STALE, "eventsub");
      await insertStreamEventSubCoverage(database, "kanal-eventsub");
      await insertStreamState(database, "kanal-uncovered-eventsub", "offline", FRESH, "eventsub");

      const channelIds = await listChannelIdsNeedingStreamStateRefresh(database as unknown as D1Database, NOW, 600, 50);

      expect(channelIds).toEqual(["kanal-missing", "kanal-eventsub", "kanal-stale-helix"]);
    } finally {
      database.close();
    }
  });

  it("caps the result at the given limit (#178)", async () => {
    const database = new TestD1Database();
    try {
      for (let index = 0; index < 5; index += 1) await insertChannel(database, `kanal-${String(index)}`);

      const channelIds = await listChannelIdsNeedingStreamStateRefresh(database as unknown as D1Database, NOW, 600, 3);

      expect(channelIds).toEqual(["kanal-0", "kanal-1", "kanal-2"]);
    } finally {
      database.close();
    }
  });

  it("orders missing rows first, then stale rows by oldest changed_at", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-newer");
      await insertChannel(database, "kanal-older");
      await insertChannel(database, "kanal-missing");
      await insertStreamState(database, "kanal-newer", "offline", "2026-09-23T11:48:00.000Z", "helix");
      await insertStreamState(database, "kanal-older", "offline", "2026-09-23T11:40:00.000Z", "helix");

      const channelIds = await listChannelIdsNeedingStreamStateRefresh(database as unknown as D1Database, NOW, 600, 3);

      expect(channelIds).toEqual(["kanal-missing", "kanal-older", "kanal-newer"]);
    } finally {
      database.close();
    }
  });
});

describe("maintainStreamStates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("backfills channels without a row and refreshes ones with a stale Helix row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertChannel(database, "kanal-b");
      await insertStreamState(database, "kanal-a", "offline", STALE, "helix");
      await withAppToken(database);
      const fetcher = helixResponse(true);

      await maintainStreamStates(environment(database), NOW, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
      await expect(database.prepare(
        "SELECT channel_id, state, source FROM channel_stream_state ORDER BY channel_id",
      ).all()).resolves.toMatchObject({
        results: [
          { channel_id: "kanal-a", state: "online", source: "helix" },
          { channel_id: "kanal-b", state: "online", source: "helix" },
        ],
      });
    } finally {
      database.close();
    }
  });

  it("makes no Helix call when every channel already has a fresh row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "online", NOW, "eventsub");
      await insertStreamEventSubCoverage(database, "kanal-a");
      const fetcher = vi.fn<typeof fetch>();

      await maintainStreamStates(environment(database), NOW, fetcher);

      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("picks up the remaining stale Helix channels on the next tick instead of starving them", async () => {
    const database = new TestD1Database();
    try {
      for (let index = 0; index < 55; index += 1) {
        const channelId = `kanal-${String(index).padStart(3, "0")}`;
        await insertChannel(database, channelId);
        await insertStreamState(database, channelId, "offline", STALE, "helix");
      }
      await withAppToken(database);
      const fetcher = helixResponse(false);

      await maintainStreamStates(environment(database), NOW, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(50);
      await expect(database.prepare(
        "SELECT channel_id FROM channel_stream_state WHERE changed_at = ? ORDER BY channel_id",
      ).bind(STALE).all()).resolves.toMatchObject({
        results: Array.from({ length: 5 }, (_, index) => ({ channel_id: `kanal-${String(index + 50).padStart(3, "0")}` })),
      });

      await maintainStreamStates(environment(database), NOW, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(55);
    } finally {
      database.close();
    }
  });

  it("stops the run on a 429 and leaves the remaining channels untouched (#178)", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertChannel(database, "kanal-b");
      await withAppToken(database);
      const fetcher = rateLimitedResponse();

      await maintainStreamStates(environment(database), NOW, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(database.prepare("SELECT COUNT(*) AS count FROM channel_stream_state").first())
        .resolves.toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
