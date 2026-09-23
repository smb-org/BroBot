import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { lookupAndStoreStreamStateIfMissing, maintainMissingStreamStates } from "../../src/worker/stream-state-lookup";
import { insertAppAccessToken, insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-23T12:00:00.000Z";
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

const helixResponse = (online: boolean) => vi.fn<typeof fetch>().mockResolvedValue(
  new Response(JSON.stringify({ data: online ? [{ id: "live-1" }] : [] }), { status: 200 }),
);

describe("lookupAndStoreStreamStateIfMissing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("looks up Helix and stores the result when no row exists", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await withAppToken(database);
      const fetcher = helixResponse(true);

      const state = await lookupAndStoreStreamStateIfMissing(environment(database), "kanal-a", NOW, fetcher);

      expect(state).toBe("online");
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(database.prepare(
        "SELECT state, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", source: "helix" });
    } finally {
      database.close();
    }
  });

  it("does not call Helix when a row already exists", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
         VALUES ('kanal-a', 'offline', ?, 'eventsub')`,
      ).bind(NOW).run();
      const fetcher = vi.fn<typeof fetch>();

      const state = await lookupAndStoreStreamStateIfMissing(environment(database), "kanal-a", NOW, fetcher);

      expect(state).toBe("offline");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("lets a concurrent EventSub write win over its own Helix result", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await withAppToken(database);
      // A real EventSub delivery slips in between this call's read and its
      // write -- `writeHelixStreamStateIfUnknown`'s `ON CONFLICT DO NOTHING`
      // must not clobber it.
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        await database.prepare(
          `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
           VALUES ('kanal-a', 'online', ?, 'eventsub')`,
        ).bind(NOW).run();
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const state = await lookupAndStoreStreamStateIfMissing(environment(database), "kanal-a", NOW, fetcher);

      expect(state).toBe("online");
      await expect(database.prepare(
        "SELECT state, changed_at, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", changed_at: NOW, source: "eventsub" });
    } finally {
      database.close();
    }
  });
});

describe("maintainMissingStreamStates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("backfills only channels without a stream state row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertChannel(database, "kanal-b");
      await database.prepare(
        `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
         VALUES ('kanal-a', 'offline', ?, 'eventsub')`,
      ).bind(NOW).run();
      await withAppToken(database);
      const fetcher = helixResponse(true);

      await maintainMissingStreamStates(environment(database), NOW, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(database.prepare(
        "SELECT channel_id, state, source FROM channel_stream_state ORDER BY channel_id",
      ).all()).resolves.toMatchObject({
        results: [
          { channel_id: "kanal-a", state: "offline", source: "eventsub" },
          { channel_id: "kanal-b", state: "online", source: "helix" },
        ],
      });
    } finally {
      database.close();
    }
  });

  it("makes no Helix call when every channel already has a row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
         VALUES ('kanal-a', 'online', ?, 'eventsub')`,
      ).bind(NOW).run();
      const fetcher = vi.fn<typeof fetch>();

      await maintainMissingStreamStates(environment(database), NOW, fetcher);

      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
