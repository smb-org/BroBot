import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { fetchTwitchUsersById } from "../../src/worker/twitch/user-resolution";
import { TestD1Database } from "./test-d1";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const encryptionKeys = JSON.stringify({ active: { id: "encryption-v1", key }, retired: [] });

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  SESSION_ENCRYPTION_KEYS: encryptionKeys,
  TWITCH_CLIENT_ID: "test-client-id",
} as Env);

const insertBotIdentity = async (database: TestD1Database): Promise<void> => {
  const keys = parseKeyRing(encryptionKeys);
  const access = await encryptJson({ token: "bot-access-token" }, keys);
  const refresh = await encryptJson({ token: "bot-refresh-token" }, keys);
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, 'bot-user', 'bot', '[]', ?, ?, ?, ?, ?)`,
  ).bind(access, refresh, "2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const usersResponse = (ids: string[]): Response => new Response(JSON.stringify({
  data: ids.map((id) => ({ id, login: `login-${id}`, display_name: `Name ${id}` })),
}), { status: 200, headers: { "Content-Type": "application/json" } });

describe("Twitch user lookup cache", () => {
  let database: TestD1Database;

  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  it("looks up every requested ID in Helix batches of at most 100", async () => {
    database = new TestD1Database();
    await insertBotIdentity(database);
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const ids = url.searchParams.getAll("id");
      return Promise.resolve(usersResponse(ids));
    });

    const resolved = await fetchTwitchUsersById(fetcher, environmentFor(database), Array.from({ length: 150 }, (_, index) => `user-${String(index)}`));

    expect(fetcher).toHaveBeenCalledTimes(2);
    const requested = fetcher.mock.calls.flatMap(([input]) =>
      new URL(input instanceof Request ? input.url : input.toString()).searchParams.getAll("id"));
    expect(fetcher.mock.calls.every(([input]) =>
      new URL(input instanceof Request ? input.url : input.toString()).searchParams.getAll("id").length <= 100)).toBe(true);
    expect(requested).toHaveLength(150);
    expect(new Set(requested).size).toBe(150);
    expect(resolved.size).toBe(150);
  });

  it("prunes expired creator entries when a new entry is inserted", async () => {
    vi.useFakeTimers();
    database = new TestD1Database();
    await insertBotIdentity(database);
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(usersResponse(url.searchParams.getAll("id")));
    });
    const deleteMapEntry = Object.getOwnPropertyDescriptor(Map.prototype, "delete")?.value as
      (this: Map<unknown, unknown>, key: unknown) => boolean;
    const deletedKeys = new Set<string>();
    const deleteSpy = vi.spyOn(Map.prototype, "delete").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      if (key === "creator-expired") deletedKeys.add(key);
      return deleteMapEntry.call(this, key);
    });

    try {
      await fetchTwitchUsersById(fetcher, environmentFor(database), ["creator-expired"]);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await fetchTwitchUsersById(fetcher, environmentFor(database), ["creator-new"]);

      expect(deletedKeys.has("creator-expired")).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it("caps the creator cache at 1,000 entries and evicts the oldest", async () => {
    database = new TestD1Database();
    await insertBotIdentity(database);
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(usersResponse(url.searchParams.getAll("id")));
    });
    const environment = environmentFor(database);

    for (let offset = 0; offset < 1_000; offset += 100) {
      await fetchTwitchUsersById(fetcher, environment,
        Array.from({ length: 100 }, (_, index) => `creator-${String(offset + index)}`));
    }
    await fetchTwitchUsersById(fetcher, environment, ["creator-newest"]);
    await fetchTwitchUsersById(fetcher, environment, ["creator-0"]);

    expect(fetcher).toHaveBeenCalledTimes(12);
  });

  it("coalesces concurrent lookups for the same user ID", async () => {
    database = new TestD1Database();
    await insertBotIdentity(database);
    let finish!: (response: Response) => void;
    const responseGate = new Promise<Response>((resolve) => { finish = resolve; });
    const fetcher = vi.fn<typeof fetch>(() => responseGate);
    const environment = environmentFor(database);

    const first = fetchTwitchUsersById(fetcher, environment, ["creator-1"]);
    const second = fetchTwitchUsersById(fetcher, environment, ["creator-1"]);
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    finish(usersResponse(["creator-1"]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      new Map([["creator-1", expect.objectContaining({ displayName: "Name creator-1" })]]),
      new Map([["creator-1", expect.objectContaining({ displayName: "Name creator-1" })]]),
    ]);
  });

  it("refreshes a cached display name after its TTL", async () => {
    vi.useFakeTimers();
    database = new TestD1Database();
    await insertBotIdentity(database);
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(usersResponse(url.searchParams.getAll("id")));
    });
    const environment = environmentFor(database);

    await fetchTwitchUsersById(fetcher, environment, ["creator-ttl"]);
    await fetchTwitchUsersById(fetcher, environment, ["creator-ttl"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    await fetchTwitchUsersById(fetcher, environment, ["creator-ttl"]);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
