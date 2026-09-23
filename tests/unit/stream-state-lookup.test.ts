import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { listChannelIdsNeedingStreamStateRefresh } from "../../src/worker/db/channels";
import { lookupAndRefreshStreamState, maintainStreamStates } from "../../src/worker/stream-state-lookup";
import { insertAppAccessToken, insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

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

// `mockImplementation`, not `mockResolvedValue` with one shared `Response`:
// a `Response` body can only be read once, and every test here that calls
// the fetcher more than once (the cron loop, a refresh) needs a fresh one.
const helixResponse = (online: boolean, startedAt: string | null = null) => vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
  new Response(JSON.stringify({ data: online ? [{ id: "live-1", ...(startedAt === null ? {} : { started_at: startedAt }) }] : [] }), { status: 200 }),
));

const rateLimitedResponse = () => vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
  new Response(JSON.stringify({}), { status: 429 }),
));

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

  it("does not call Helix when a fresh row already exists", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertStreamState(database, "kanal-a", "offline", NOW, "eventsub");
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

  it("refreshes a stale Helix-sourced row instead of returning it forever (#178)", async () => {
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
      await withAppToken(database);
      // The channel gains `channel:bot` consent and its first real EventSub
      // delivery lands while this stale refresh is still in flight.
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        await database.prepare(
          `UPDATE channel_stream_state SET state = 'online', changed_at = ?, source = 'eventsub', started_at = ?
            WHERE channel_id = 'kanal-a'`,
        ).bind(NOW, "2026-09-23T11:59:00.000Z").run();
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
  it("includes channels missing a row and stale Helix rows, excluding fresh Helix and any EventSub row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-missing");
      await insertChannel(database, "kanal-stale-helix");
      await insertChannel(database, "kanal-fresh-helix");
      await insertChannel(database, "kanal-eventsub");
      await insertStreamState(database, "kanal-stale-helix", "offline", STALE, "helix");
      await insertStreamState(database, "kanal-fresh-helix", "offline", FRESH, "helix");
      // An EventSub row long past the TTL age must still be excluded --
      // staleness only ever applies to Helix-sourced rows.
      await insertStreamState(database, "kanal-eventsub", "offline", STALE, "eventsub");

      const channelIds = await listChannelIdsNeedingStreamStateRefresh(database as unknown as D1Database, NOW, 600, 50);

      expect(channelIds).toEqual(["kanal-missing", "kanal-stale-helix"]);
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
      const fetcher = vi.fn<typeof fetch>();

      await maintainStreamStates(environment(database), NOW, fetcher);

      expect(fetcher).not.toHaveBeenCalled();
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
