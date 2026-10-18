import { afterEach, describe, expect, it, vi } from "vitest";

import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { chatVotingModule } from "../../src/modules/chat_voting";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { votekickModule } from "../../src/modules/votekick";
import { createVotekickRepository } from "../../src/modules/votekick/adapters/d1";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { dryRunChatMessage } from "../../src/worker/dry-run";
import { castStoredBallotTerm, openStoredBallot, readStoredBallotDryRunSnapshot } from "../../src/worker/durable/ballots";
import { insertAppAccessToken, insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";
const CHANNEL_ID = "kanal-a";
const TOKEN_ENCRYPTION_KEYS = JSON.stringify({
  active: { id: "dry-run-token", key: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url") },
  retired: [],
});

const snapshotTables = (database: TestD1Database): Readonly<Record<string, unknown>> => {
  const tables = database.sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [
    name,
    database.sqlite.prepare(`SELECT * FROM "${name}"`).all(),
  ]));
};

const memoryBallotStorage = (): {
  storage: Parameters<typeof openStoredBallot>[0];
  readonly writes: number;
  readonly alarms: number;
  reset: () => void;
} => {
  type Transaction = {
    get: <Value>(key: string) => Promise<Value | undefined>;
    list: (options?: { prefix?: string; startAfter?: string; limit?: number }) => Promise<Map<string, unknown>>;
    put: (key: string, value: unknown) => Promise<void>;
    delete: (keys: string | string[]) => Promise<boolean>;
    setAlarm: () => Promise<void>;
    deleteAlarm: () => Promise<void>;
  };
  const values = new Map<string, unknown>();
  let writes = 0;
  let alarms = 0;
  const transaction: Transaction = {
    get: <Value>(key: string) => Promise.resolve(values.get(key) as Value | undefined),
    list: (options = {}) => Promise.resolve(new Map(
      [...values.entries()].filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix)),
    )),
    put: (key, value) => { writes += 1; values.set(key, value); return Promise.resolve(); },
    delete: (keys) => {
      writes += 1;
      return Promise.resolve((Array.isArray(keys) ? keys : [keys]).some((key) => values.delete(key)));
    },
    setAlarm: () => { alarms += 1; return Promise.resolve(); },
    deleteAlarm: () => { alarms += 1; return Promise.resolve(); },
  };
  const storage = {
    get: transaction.get,
    list: transaction.list,
    put: transaction.put,
    delete: transaction.delete,
    transaction: async <Value>(closure: (transaction: Transaction) => Promise<Value>) => await closure(transaction),
  } as unknown as Parameters<typeof openStoredBallot>[0];
  return {
    storage,
    get writes() { return writes; },
    get alarms() { return alarms; },
    reset: () => { writes = 0; alarms = 0; },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dryRunChatMessage", () => {
  it("runs the text-command service without writes, cooldown changes, provider fetches, or cache fills", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("Dry-run must not fetch providers.")));
    vi.stubGlobal("fetch", fetcher);
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'text_commands', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'faq', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      await database.prepare(
        `INSERT INTO bot_identity
          (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, created_at, updated_at)
         VALUES (1, 'bot-user', 'brobot', '[]', 'access', 'refresh', ?, ?, ?)`,
      ).bind("2099-09-20T00:00:00.000Z", NOW, NOW).run();
      await database.prepare("UPDATE channels SET default_chat_target = 'where_asked' WHERE channel_id = ?")
        .bind(CHANNEL_ID).run();
      await database.prepare(
        "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES (?, 'score', 41, ?, ?)",
      ).bind(CHANNEL_ID, NOW, NOW).run();
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      await repository.create({
        channelId: CHANNEL_ID,
        name: "score",
        text: "Score {var.score}: {api.status}; {currency.convert USD EUR}",
        kind: "text",
        aliases: ["points"],
        cooldownSeconds: 30,
        userCooldownSeconds: 60,
        variableAction: { name: "score", operation: "add", amount: 1 },
        responseType: "reply",
        chatTarget: "where_asked",
        now: NOW,
      }, { userId: "member-1" });
      await repository.create({
        channelId: CHANNEL_ID,
        name: "timeout",
        text: "Timeout fallback",
        kind: "timeout",
        cooldownSeconds: 0,
        timeoutAction: { minSeconds: 20, maxSeconds: 60, fallbackText: "Timeout unavailable" },
        now: NOW,
      }, { userId: "member-1" });
      await repository.create({
        channelId: CHANNEL_ID,
        name: "shout",
        text: "Shoutout {target}",
        kind: "shoutout",
        cooldownSeconds: 0,
        now: NOW,
      }, { userId: "member-1" });
      await database.prepare(
        `INSERT INTO api_sources (channel_id, source_name, url, expression, revision, created_at, updated_at)
         VALUES (?, 'status', 'https://provider.example/status', '$.status', 1, ?, ?)`,
      ).bind(CHANNEL_ID, NOW, NOW).run();
      await database.prepare(
        `INSERT INTO faq_entries (faq_id, channel_id, name, matcher_json, answer_text, created_at, updated_at)
         VALUES ('faq-status', ?, 'Status', '{"type":"keywords","patterns":["status"]}', 'Online', ?, ?)`,
      ).bind(CHANNEL_ID, NOW, NOW).run();

      const before = snapshotTables(database);
      const environment = {
        DB: database as unknown as D1Database,
        PUBLIC_ORIGIN: "https://brobot.example",
      } as unknown as Env;
      const request = {
        text: "!points 10",
        sender: { login: "viewer_42", statuses: [] },
        streamState: "online",
        game: null,
        sharedChat: true,
      } as const;

      const first = await dryRunChatMessage(environment, CHANNEL_ID, request, fetcher);
      const second = await dryRunChatMessage(environment, CHANNEL_ID, request, fetcher);
      const faqRequest = { ...request, text: "status", only: { moduleId: "faq" as const, entryId: "faq-status" } };
      const firstFaq = await dryRunChatMessage(environment, CHANNEL_ID, faqRequest, fetcher);
      const secondFaq = await dryRunChatMessage(environment, CHANNEL_ID, faqRequest, fetcher);

      expect(first.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0]).toMatchObject({
        entry: { id: "score" },
        outcome: "fires",
        match: { kind: "alias", token: "points" },
        effects: [
          { kind: "chat", target: "where_asked", postsTo: "all_shared_chats", reply: true },
          { kind: "variable", name: "score", from: 41, to: 42 },
          { kind: "cooldown", scope: "global", seconds: 30 },
          { kind: "cooldown", scope: "user", seconds: 60 },
        ],
      });
      expect(first.sender).toMatchObject({ resolved: false, perUserCooldownsUseSyntheticId: true });
      expect(first.sender.userId).toMatch(/^dry-run:/u);
      expect(firstFaq.modules.find(({ moduleId }) => moduleId === "faq")?.entries[0]).toMatchObject({
        entry: { id: "faq-status" },
        outcome: "fires",
        match: { kind: "keyword", pattern: "status" },
      });
      expect(second.modules).toEqual(first.modules);
      expect(secondFaq.modules).toEqual(firstFaq.modules);
      expect(snapshotTables(database)).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("does not refresh a missing app token while resolving a dry-run votekick target", async () => {
    const database = new TestD1Database();
    const fetcher = vi.fn<typeof fetch>((input) => Promise.resolve(new Response(
      JSON.stringify((typeof input === "string" ? input : input instanceof Request ? input.url : input.href).includes("oauth2/token")
        ? { access_token: "new-app-token", expires_in: 7200 }
        : { data: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)",
      ).bind(CHANNEL_ID, JSON.stringify(votekickModule.defaultSettings)).run();
      const before = snapshotTables(database);
      const response = await dryRunChatMessage({
        DB: database as unknown as D1Database,
        PUBLIC_ORIGIN: "https://brobot.example",
        TWITCH_CLIENT_ID: "client-id",
        TWITCH_CLIENT_SECRET: "client-secret",
        TOKEN_ENCRYPTION_KEYS,
      } as unknown as Env, CHANNEL_ID, {
        text: "!votekick @missing_user",
        sender: { login: "viewer_42", statuses: ["vip"] },
        streamState: "online",
        game: null,
        sharedChat: false,
        only: { moduleId: "votekick" },
      }, fetcher);

      expect(fetcher).not.toHaveBeenCalled();
      expect(snapshotTables(database)).toEqual(before);
      expect(response.modules[0]?.entries[0]?.templateNotes).toContainEqual({
        code: "template.deferred_live",
        detail: { name: "votekick.target" },
      });
    } finally {
      database.close();
    }
  });

  it("treats an unreadable cached token as resolved at send time without fetching", async () => {
    const database = new TestD1Database();
    const wrongKeys = JSON.stringify({
      active: { id: "different-key", key: Buffer.from(new Uint8Array(32).fill(8)).toString("base64url") },
      retired: [],
    });
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("Dry-run must not fetch without a valid token.")));
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)",
      ).bind(CHANNEL_ID, JSON.stringify(votekickModule.defaultSettings)).run();
      await insertAppAccessToken(
        database,
        await encryptJson({ token: "unreadable-token" }, parseKeyRing(wrongKeys)),
        "2099-09-20T00:00:00.000Z",
        NOW,
        NOW,
      );
      const before = snapshotTables(database);

      const response = await dryRunChatMessage({
        DB: database as unknown as D1Database,
        PUBLIC_ORIGIN: "https://brobot.example",
        TWITCH_CLIENT_ID: "client-id",
        TOKEN_ENCRYPTION_KEYS: "invalid-key-ring",
      } as unknown as Env, CHANNEL_ID, {
        text: "!votekick @target_viewer",
        sender: { login: "viewer_42", statuses: ["vip"] },
        streamState: "online",
        game: null,
        sharedChat: false,
        only: { moduleId: "votekick" },
      }, fetcher);

      expect(fetcher).not.toHaveBeenCalled();
      expect(snapshotTables(database)).toEqual(before);
      expect(response.modules[0]?.entries[0]?.templateNotes).toContainEqual({
        code: "template.deferred_live",
        detail: { name: "votekick.target" },
      });
    } finally {
      database.close();
    }
  });

  it("keeps an open D1 vote silent when the read-only ballot snapshot is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const database = new TestD1Database();
    const channelObject = {
      readBallotDryRunSnapshot: () => Promise.resolve(null),
      hasOpenBallotSnapshot: () => Promise.resolve(false),
    };
    const channelNamespace = {
      idFromName: () => CHANNEL_ID,
      get: () => channelObject,
    } as unknown as Env["CHANNEL"];
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("Dry-run must not refresh an app token.")));
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      await createChatVotingRepository(database as unknown as D1Database).insertOpen({
        id: "open-d1-without-do-ballot",
        channelId: CHANNEL_ID,
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: null,
        resultText: "{vote.result}",
        textMode: null,
        termFilterReady: null,
        openedAt: "2026-09-19T11:59:00.000Z",
        closesAt: "2026-09-19T12:01:00.000Z",
        requestedDurationSeconds: null,
        closeReason: "manual",
        textResults: null,
        moreTerms: null,
      });

      const response = await dryRunChatMessage({
        DB: database as unknown as D1Database,
        CHANNEL: channelNamespace,
        PUBLIC_ORIGIN: "https://brobot.example",
      } as unknown as Env, CHANNEL_ID, {
        text: "1",
        sender: { login: "viewer_42", statuses: [] },
        streamState: "online",
        game: null,
        sharedChat: false,
        only: { moduleId: "chat_voting" },
      }, fetcher);

      expect(response.modules[0]).toMatchObject({ status: "silent", entries: [] });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("keeps a votekick silent when its stored ballot is inactive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const database = new TestD1Database();
    const channelObject = {
      readBallotDryRunSnapshot: () => Promise.resolve({
        counts: [0, 0],
        revision: 1,
        expiresAt: Date.parse("2026-09-19T12:01:00.000Z"),
        previousChoiceKnown: false,
        isActive: false,
      }),
      hasOpenBallotSnapshot: () => Promise.resolve(false),
    };
    const channelNamespace = {
      idFromName: () => CHANNEL_ID,
      get: () => channelObject,
    } as unknown as Env["CHANNEL"];
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("Dry-run must not refresh an app token.")));
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)",
      ).bind(CHANNEL_ID, JSON.stringify(votekickModule.defaultSettings)).run();
      await createVotekickRepository(database as unknown as D1Database).admit(CHANNEL_ID, {
        id: "running-inactive-kick",
        targetUserId: "target-id",
        targetLogin: "target_viewer",
        initiatorUserId: "starter-id",
        threshold: 3,
        yesVotes: 0,
        ballotRevision: 1,
        startedAt: "2026-09-19T11:59:00.000Z",
        endsAt: "2026-09-19T12:01:00.000Z",
      }, NOW, 0, 0);

      const response = await dryRunChatMessage({
        DB: database as unknown as D1Database,
        CHANNEL: channelNamespace,
        PUBLIC_ORIGIN: "https://brobot.example",
      } as unknown as Env, CHANNEL_ID, {
        text: "1",
        sender: { login: "viewer_42", statuses: [] },
        streamState: "online",
        game: null,
        sharedChat: false,
        only: { moduleId: "votekick" },
      }, fetcher);

      expect(response.modules[0]).toMatchObject({ status: "silent", entries: [] });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("resolves the simulated sender with a cached token before reading their ballot choice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const database = new TestD1Database();
    const ballotVoterIds: (string | undefined)[] = [];
    const channelObject = {
      readBallotDryRunSnapshot: (moduleId: string, ballotId: string, voterId?: string) => {
        expect(moduleId).toBe("votekick");
        expect(ballotId).toBe("kick-with-existing-vote");
        ballotVoterIds.push(voterId);
        return Promise.resolve({
          counts: [0, 0],
          revision: 1,
          expiresAt: Date.parse("2026-09-19T12:01:00.000Z"),
          isActive: true,
        });
      },
      hasOpenBallotSnapshot: () => Promise.resolve(false),
      getActiveChatterSnapshot: (userId: string) => {
        expect(userId).toBe("real-viewer-id");
        return Promise.resolve({
          firstSeenAt: "2026-09-19T11:58:00.000Z",
          lastSeenAt: NOW,
        });
      },
      getActiveChatterCountSnapshot: () => Promise.resolve(0),
    };
    const channelNamespace = {
      idFromName: () => CHANNEL_ID,
      get: () => channelObject,
    } as unknown as Env["CHANNEL"];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      expect(url).toBe("https://api.twitch.tv/helix/users?login=viewer_42");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer cached-app-token");
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ id: "real-viewer-id", login: "viewer_42", display_name: "Viewer 42" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)",
      ).bind(CHANNEL_ID, JSON.stringify(votekickModule.defaultSettings)).run();
      await insertAppAccessToken(
        database,
        await encryptJson({ token: "cached-app-token" }, parseKeyRing(TOKEN_ENCRYPTION_KEYS)),
        "2099-09-20T00:00:00.000Z",
        NOW,
        NOW,
      );
      const repository = createVotekickRepository(database as unknown as D1Database);
      await repository.admit(CHANNEL_ID, {
        id: "kick-with-existing-vote",
        targetUserId: "target-id",
        targetLogin: "target_viewer",
        initiatorUserId: "starter-id",
        threshold: 3,
        yesVotes: 1,
        ballotRevision: 1,
        startedAt: "2026-09-19T11:59:00.000Z",
        endsAt: "2026-09-19T12:01:00.000Z",
      }, NOW, 0, 0);

      const response = await dryRunChatMessage({
        DB: database as unknown as D1Database,
        CHANNEL: channelNamespace,
        PUBLIC_ORIGIN: "https://brobot.example",
        TWITCH_CLIENT_ID: "client-id",
        TWITCH_CLIENT_SECRET: "client-secret",
        TOKEN_ENCRYPTION_KEYS,
      } as unknown as Env, CHANNEL_ID, {
        text: "1",
        sender: { login: "viewer_42", statuses: ["vip"] },
        streamState: "online",
        game: null,
        sharedChat: false,
        only: { moduleId: "votekick" },
      }, fetcher);

      expect(ballotVoterIds).toEqual(["real-viewer-id"]);
      expect(response.modules[0]?.entries[0]).toMatchObject({
        outcome: "fires",
        effects: [{ kind: "ballot", action: "count", choice: "yes", counts: [1, 0] }],
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls.every(([input]) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
        return !url.includes("oauth2/token");
      })).toBe(true);
    } finally {
      database.close();
    }
  });

  it("reports unresolved ballots without synthetic activity reads or storage mutations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const database = new TestD1Database();
    const calls = { ballotReads: 0, activityReads: 0, mutations: 0, alarms: 0 };
    const forbidden = (): never => {
      calls.mutations += 1;
      throw new Error("Dry-run called a Durable Object mutation RPC.");
    };
    const channelObject = {
      readBallotDryRunSnapshot: (moduleId: string, ballotId: string, voterId?: string) => {
        expect(["chat_voting", "votekick"]).toContain(moduleId);
        expect(ballotId).toBe(moduleId === "chat_voting" ? "poll-1" : "running-kick");
        calls.ballotReads += 1;
        return Promise.resolve({ counts: [0, 0], revision: 0, previousChoiceKnown: voterId !== undefined });
      },
      hasOpenBallotSnapshot: () => {
        calls.ballotReads += 1;
        return Promise.resolve(false);
      },
      getActiveChatterSnapshot: () => {
        calls.activityReads += 1;
        return Promise.resolve(null);
      },
      getActiveChatterCountSnapshot: () => {
        calls.activityReads += 1;
        return Promise.resolve(20);
      },
      openBallot: forbidden,
      castBallot: forbidden,
      castBallotTerm: forbidden,
      closeBallot: forbidden,
      finalizeBallot: forbidden,
      acknowledgeClosedBallot: forbidden,
      recordChatActivity: forbidden,
      clearActiveChatters: forbidden,
      scheduleModuleAlarm: forbidden,
      clearModuleAlarm: forbidden,
      runModuleAlarm: forbidden,
      setAlarm: forbidden,
      deleteAlarm: forbidden,
    };
    const channelNamespace = {
      idFromName: () => CHANNEL_ID,
      get: () => channelObject,
    } as unknown as Env["CHANNEL"];
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("Dry-run must not fetch providers.")));
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)",
      ).bind(CHANNEL_ID, JSON.stringify(votekickModule.defaultSettings)).run();
      const voteRepository = createChatVotingRepository(database as unknown as D1Database);
      await voteRepository.insertOpen({
        id: "poll-1",
        channelId: CHANNEL_ID,
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: null,
        resultText: "{vote.result}",
        textMode: null,
        termFilterReady: null,
        openedAt: new Date(Date.parse(NOW) - 60_000).toISOString(),
        closesAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
        requestedDurationSeconds: null,
        closeReason: "limit",
        textResults: null,
        moreTerms: null,
      });
      const kickRepository = createVotekickRepository(database as unknown as D1Database);
      await kickRepository.admit(CHANNEL_ID, {
        id: "running-kick",
        targetUserId: "target-id",
        targetLogin: "protected_viewer",
        initiatorUserId: "starter-id",
        threshold: 3,
        yesVotes: 0,
        ballotRevision: 1,
        startedAt: new Date(Date.parse(NOW) - 120_000).toISOString(),
        endsAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
      }, NOW, 0, 0);

      const before = snapshotTables(database);
      const response = await dryRunChatMessage({
        DB: database as unknown as D1Database,
        CHANNEL: channelNamespace,
        PUBLIC_ORIGIN: "https://brobot.example",
      } as unknown as Env, CHANNEL_ID, {
        text: "1",
        sender: { login: "viewer_42", statuses: [] },
        streamState: "online",
        game: null,
        sharedChat: false,
      }, fetcher, [chatVotingModule, votekickModule]);

      expect(response.modules.map(({ moduleId }) => moduleId)).toEqual(["chat_voting", "votekick"]);
      expect(response.modules.every(({ status }) => status !== "error" && status !== "not_testable")).toBe(true);
      expect(response.modules.find(({ moduleId }) => moduleId === "chat_voting")).toMatchObject({
        status: "indeterminate",
        entries: [{
          outcome: "indeterminate",
          effects: [],
          templateNotes: [{ code: "template.deferred_live", detail: { name: "ballot.previous_choice" } }],
        }],
      });
      expect(response.modules.find(({ moduleId }) => moduleId === "votekick")).toMatchObject({
        status: "indeterminate",
        entries: [{
          outcome: "indeterminate",
          effects: [],
          templateNotes: [{ code: "template.deferred_live", detail: { name: "ballot.previous_choice" } }],
        }],
      });
      expect(calls.ballotReads).toBeGreaterThan(0);
      expect(calls.activityReads).toBe(0);
      expect(calls.mutations).toBe(0);
      expect(calls.alarms).toBe(0);
      expect(snapshotTables(database)).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("reads a durable ballot snapshot without storage writes or alarm changes", async () => {
    const storage = memoryBallotStorage();
    const expiresAt = Date.now() + 60_000;
    const opened = await openStoredBallot(
      storage.storage,
      "chat_voting",
      "dry-run-text-ballot",
      0,
      expiresAt,
      undefined,
      undefined,
      undefined,
      { blockedTerms: ["spoiler"] },
    );
    expect(opened.status).toBe("opened");
    await castStoredBallotTerm(storage.storage, "channel-a", "chat_voting", "dry-run-text-ballot", "voter-a", "sunny");
    storage.reset();

    const snapshot = await readStoredBallotDryRunSnapshot(
      storage.storage, "chat_voting", "dry-run-text-ballot", "channel-a", "voter-a",
    );

    expect(snapshot).toMatchObject({
      counts: [],
      blockedTerms: ["spoiler"],
      termFilterReady: true,
      expiresAt,
      previousChoice: "sunny",
      isActive: true,
    });
    expect(storage.writes).toBe(0);
    expect(storage.alarms).toBe(0);
  });
});
