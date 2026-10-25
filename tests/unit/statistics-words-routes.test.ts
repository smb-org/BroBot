import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { statisticsRoutes } from "../../src/modules/statistics/routes";
import { requireChannelAuthorization } from "../../src/worker/auth/guards";
import { createSessionCookie } from "../../src/worker/auth/session";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "statistics-words-channel";
const USER_ID = "statistics-words-user";
const cookieKeys = JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] });
const encryptionKeys = JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] });
const databases: TestD1Database[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T23:59:00.000Z"));
});

const setup = async (
  member = true,
  wrapDatabase: (inner: TestD1Database) => D1Database = (inner) => inner as unknown as D1Database,
): Promise<{ database: TestD1Database; fetch: (path: string) => Promise<Response> }> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await insertLoginIdentityAndSession(database, USER_ID);
  if (member) await insertMember(database, CHANNEL_ID, USER_ID, "manager");
  const sessionCookie = await createSessionCookie({ sessionId: `session-${USER_ID}` }, cookieKeys, encryptionKeys);
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("/channels/:channelId/modules/statistics/*", requireChannelAuthorization());
  app.route("/channels/:channelId/modules/statistics", statisticsRoutes);
  const environment = {
    DB: wrapDatabase(database),
    SESSION_COOKIE_KEYS: cookieKeys,
    SESSION_ENCRYPTION_KEYS: encryptionKeys,
  } as Env;
  return {
    database,
    fetch: async (path) => await app.fetch(new Request(`https://brobot.example${path}`, {
      headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
    }), environment),
  };
};

const putWord = async (
  database: TestD1Database,
  word: string,
  totalCount: number,
  lastSeenAt = "2026-10-25T12:00:00.000Z",
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(CHANNEL_ID, word, totalCount, lastSeenAt).run();
};

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

describe("statistics words route", () => {
  it("denies a non-member before returning channel word counts", async () => {
    const { fetch } = await setup(false);

    const response = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "channel_access_denied" });
  });

  it("pages the baseline by count and word with 100 rows per page", async () => {
    const { database, fetch } = await setup();
    for (let index = 0; index < 101; index += 1) {
      await putWord(database, `word-${String(index).padStart(3, "0")}`, 200 - index);
    }

    const firstResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words`);
    const first = await firstResponse.json<{
      words: Array<{ word: string; rank: number }>;
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    }>();
    const secondResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words?page=2`);
    const second = await secondResponse.json<{ words: Array<{ word: string; rank: number }>; page: number }>();

    expect(firstResponse.status).toBe(200);
    expect(first).toMatchObject({ page: 1, pageSize: 100, total: 101, totalPages: 2 });
    expect(first.words).toHaveLength(100);
    expect(first.words[0]).toMatchObject({ word: "word-000", rank: 1 });
    expect(first.words[99]).toMatchObject({ word: "word-099", rank: 100 });
    expect(second).toMatchObject({ page: 2, words: [{ word: "word-100", rank: 101 }] });
  });

  it("searches case-insensitive literal substrings and ranks the filtered results", async () => {
    const { database, fetch } = await setup();
    await putWord(database, "halloween", 12);
    await putWord(database, "hallway", 11);
    await putWord(database, "hello", 10);
    await putWord(database, "other", 9);

    const response = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words?search=LLW`);
    const body = await response.json<{ words: Array<{ word: string; rank: number }>; total: number }>();

    expect(body).toMatchObject({ total: 1, words: [{ word: "hallway", rank: 1 }] });
  });

  it("hides additional chat fillers by default and includes them when requested", async () => {
    const { database, fetch } = await setup();
    await putWord(database, "hello", 10);
    await putWord(database, "guten", 7);
    await putWord(database, "lol", 5);
    await putWord(database, "nein", 2);

    const hiddenResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words`);
    const hidden = await hiddenResponse.json<{ words: Array<{ word: string }>; total: number }>();
    const shownResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words?hideFillers=false`);
    const shown = await shownResponse.json<{ words: Array<{ word: string }>; total: number }>();

    expect(hidden).toMatchObject({ total: 2, words: [{ word: "hello" }, { word: "guten" }] });
    expect(shown).toMatchObject({ total: 4, words: [{ word: "hello" }, { word: "guten" }, { word: "lol" }, { word: "nein" }] });
  });

  it("calculates each share against all stored counts", async () => {
    const { database, fetch } = await setup();
    await putWord(database, "hello", 10, "2026-10-20T12:00:00.000Z");
    await putWord(database, "lol", 5, "2026-10-21T12:00:00.000Z");

    const response = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words`);
    const body = await response.json<{
      words: Array<{ word: string; share: number }>;
      totalCount: number;
    }>();

    expect(body.totalCount).toBe(15);
    expect(body.words[0]).toMatchObject({ word: "hello", share: 10 / 15 });
  });

  it("reads count, totals and page in one snapshot when a baseline merge lands between reads", async () => {
    // Separate reads see the merge half-way; a batch is one transaction and never does.
    let merged = false;
    const { database, fetch } = await setup(true, (inner) => {
      const merge = (): void => {
        if (merged) return;
        merged = true;
        inner.sqlite.exec(
          `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at)
           VALUES ('${CHANNEL_ID}', 'merged', 1000, '2026-10-25T12:00:00.000Z')`,
        );
      };
      return {
        prepare: (sql: string) => {
          const statement = inner.prepare(sql);
          const wrapped = Object.create(statement) as typeof statement;
          wrapped.bind = (...values) => { statement.bind(...values); return wrapped; };
          const touchesBaseline = sql.includes("channel_word_frequency_baseline");
          // The inner read executes synchronously; the merge lands before the next statement starts.
          wrapped.first = <T>() => { const row = statement.first<T>(); if (touchesBaseline) merge(); return row; };
          wrapped.all = (...hint) => { const rows = statement.all(...hint); if (touchesBaseline) merge(); return rows; };
          return wrapped;
        },
        batch: (statements: unknown[]) => inner.batch(statements as never),
      } as unknown as D1Database;
    });
    await putWord(database, "hello", 10);

    const response = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words`);
    const body = await response.json<{ words: Array<{ word: string; share: number }>; total: number; totalCount: number }>();

    expect(body).toMatchObject({ total: 1, totalCount: 10, words: [{ word: "hello", share: 1 }] });
  });

  it("returns an empty page and zero totals for a channel without stored words", async () => {
    const { fetch } = await setup();

    const response = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/words`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ words: [], page: 1, pageSize: 100, total: 0, totalPages: 0, totalCount: 0, maxCount: 0 });
  });
});
