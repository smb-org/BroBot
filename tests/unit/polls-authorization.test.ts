import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { createPollsRepository } from "../../src/modules/polls/repository";
import { pollsRoutes } from "../../src/modules/polls/routes";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../../src/worker/module-authorization";
import { insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const channelId = "channel_polls";
const actorUserId = "operator_polls";
const actorSessionId = `session-${actorUserId}`;
const now = "2026-11-04T12:00:00.000Z";
const keyRing = JSON.stringify({
  active: { id: "polls-test-key", key: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url") },
  retired: [],
});

const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const removeOperatorMembership = async (database: TestD1Database): Promise<void> => {
  await database.prepare(
    "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?",
  ).bind(channelId, actorUserId).run();
};

const revokeAfterBroadcasterTokenLookup = (database: TestD1Database): D1Database => {
  let revoked = false;
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const wrapped = {
        bind(...values: Parameters<TestPreparedStatement["bind"]>) {
          statement.bind(...values);
          return wrapped;
        },
        first: async <T>() => {
          const result = await statement.first<T>();
          if (!revoked && sql.includes("FROM twitch_login_identity") && sql.includes("WHERE user_id = ?")) {
            revoked = true;
            await removeOperatorMembership(database);
          }
          return result;
        },
        all: <T>(...typeHint: readonly T[]) => statement.all(...typeHint),
        run: () => statement.run(),
      };
      return wrapped as unknown as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) =>
      database.batch(statements as unknown as TestPreparedStatement[]),
  } as unknown as D1Database;
};

describe("polls route Twitch authorization", () => {
  let database: TestD1Database;
  let environment: Env;
  let entryId: string;

  beforeEach(async () => {
    database = new TestD1Database();
    database.sqlite.prepare(
      `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
       VALUES (?, 'polls_demo', 'Polls Demo', ?, ?)`,
    ).run(channelId, now, now);
    database.sqlite.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'polls', 1, '{}')",
    ).run(channelId);
    await insertLoginIdentityAndSession(database, actorUserId);
    database.sqlite.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, 'operator', ?, ?)`,
    ).run(channelId, actorUserId, now, now);

    const ciphertext = await encryptJson({ token: "fictional-access-token" }, parseKeyRing(keyRing));
    await database.prepare(
      `INSERT INTO twitch_login_identity
        (user_id, login, scopes_json, token_scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, status, reason, created_at, updated_at)
       VALUES (?, 'polls_demo', ?, ?, ?, ?, ?, 'connected', NULL, ?, ?)`,
    ).bind(
      channelId,
      '["channel:manage:polls"]',
      '["channel:manage:polls"]',
      ciphertext,
      await encryptJson({ token: "fictional-refresh-token" }, parseKeyRing(keyRing)),
      "2099-11-04T12:00:00.000Z",
      now,
      now,
    ).run();

    const created = await createPollsRepository(database as unknown as D1Database).createEntry(channelId, {
      kind: "poll", title: "Fictional poll", choices: ["First", "Second"], durationSeconds: 60,
      channelPointsVotingEnabled: false, channelPointsPerVote: null,
    }, now);
    if (created === "limit_reached") throw new Error("Unexpected entry limit.");
    entryId = created.id;
    environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "fictional-client",
      TWITCH_CLIENT_SECRET: "fictional-secret",
      TOKEN_ENCRYPTION_KEYS: keyRing,
    } as unknown as Env;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
  });

  const makeRequest = (db: D1Database = database as unknown as D1Database): Response | Promise<Response> => {
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("actor", { userId: actorUserId, sessionId: actorSessionId });
      context.set("authorizeMutation", authorizeModuleMutation);
      context.set("authorizeManagementMutation", authorizeModuleManagementMutation);
      context.set("prepareModuleAudit", () => database.prepare("SELECT 1") as unknown as D1PreparedStatement);
      context.set("writeModuleAudit", () => Promise.resolve());
      await next();
    });
    app.route(`/api/channels/:channelId/modules/polls`, pollsRoutes);
    return app.request(
      `/api/channels/${channelId}/modules/polls/entries/${entryId}/start`,
      { method: "POST" },
      { ...environment, DB: db },
    );
  };

  it("does not create a poll after the actor loses membership before the Helix attempt", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await makeRequest(revokeAfterBroadcasterTokenLookup(database));

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not create a poll when membership is revoked during token refresh", async () => {
    await database.prepare(
      "UPDATE twitch_login_identity SET expires_at = ? WHERE user_id = ?",
    ).bind("2000-01-01T00:00:00.000Z", channelId).run();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      expect(url).toContain("/oauth2/token");
      await removeOperatorMembership(database);
      return jsonResponse({
        access_token: "fictional-refreshed-token",
        refresh_token: "fictional-next-refresh-token",
        expires_in: 7_200,
        scope: ["channel:manage:polls"],
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await makeRequest();

    expect(response.status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetcher.mock.calls[0]?.[0] as RequestInfo | URL)).toContain("/oauth2/token");
  });

  it("does not retry a poll mutation after membership is revoked during a 401 token refresh", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/oauth2/token")) {
        await removeOperatorMembership(database);
        return jsonResponse({
          access_token: "fictional-refreshed-token",
          refresh_token: "fictional-next-refresh-token",
          expires_in: 7_200,
          scope: ["channel:manage:polls"],
        });
      }
      return jsonResponse({ message: "Invalid OAuth token" }, 401);
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await makeRequest();

    expect(response.status).toBe(403);
    expect(requests.filter((request) => request.includes("/helix/polls"))).toHaveLength(1);
    expect(requests.filter((request) => request.includes("/oauth2/token"))).toHaveLength(1);
  });
});
