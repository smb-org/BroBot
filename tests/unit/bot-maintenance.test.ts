import { describe, expect, it, vi } from "vitest";

import {
  BOT_SCOPES,
  missingBotScopes,
} from "../../src/worker/auth/oauth";
import {
  fetchModeratedChannels,
  maintainBotIdentity,
  refreshBotToken,
  shouldRefreshBotToken,
  validateBotToken,
} from "../../src/worker/bot-maintenance";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import {
  setBotIdentityStatus,
} from "../../src/worker/db/bot-identity";
import { scheduled } from "../../src/worker/scheduled";

const environment = {
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  SESSION_ENCRYPTION_KEYS: JSON.stringify({
    active: {
      id: "encryption-v1",
      key: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
    },
    retired: [],
  }),
};

const makeMaintenanceEnvironment = async (
  expiresAt: string,
  status: "connected" | "revoked" = "connected",
  options: {
    failTokenWriteOnce?: boolean;
    failTokenWriteAfterCommitOnce?: boolean;
    beforeTokenWrite?: () => Promise<void>;
    onSuccessfulTokenWrite?: () => void;
    scopes?: string[];
  } = {},
) => {
  const keyRing = parseKeyRing(environment.SESSION_ENCRYPTION_KEYS);
  const initialAccessTokenCiphertext = await encryptJson({ token: "access-alt" }, keyRing);
  const initialRefreshTokenCiphertext = await encryptJson({ token: "refresh-alt" }, keyRing);
  let identity = {
    access_token_ciphertext: initialAccessTokenCiphertext,
    refresh_token_ciphertext: initialRefreshTokenCiphertext,
    expires_at: expiresAt,
    updated_at: "2026-09-17T00:00:00.000Z",
  };
  let identityStatus: {
    status: "connected" | "revoked" | "error";
    reason: string | null;
    updated_at: string;
  } = {
    status,
    reason: status === "revoked" ? "authorization_revoked" : null,
    updated_at: "2026-09-17T00:00:00.000Z",
  };
  const bind = vi.fn();
  let tokenWriteAttempts = 0;
  let successfulTokenWrites = 0;
  let missingScopesJson = "[]";
  const prepare = vi.fn((sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind: vi.fn((...args: unknown[]) => {
        values = args;
        bind(...args);
        return statement;
      }),
      first: vi.fn().mockImplementation(() => sql.includes("FROM bot_identity_status") ? {
        id: 1,
        ...identityStatus,
      } : sql.includes("FROM bot_identity") ? {
        id: 1,
        user_id: "bot-user",
        login: "brobot",
        scopes_json: JSON.stringify(options.scopes ?? []),
        ...identity,
        created_at: "2026-09-17T00:00:00.000Z",
      } : null),
      all: vi.fn().mockResolvedValue({ results: [{ channel_id: "channel-1" }] }),
      run: vi.fn().mockImplementation(async () => {
        if (sql.includes("UPDATE bot_identity") && sql.includes("missing_scopes_json")) {
          const [missingScopes, expectedAccess, expectedRefresh] = values;
          if (identity.access_token_ciphertext !== expectedAccess || identity.refresh_token_ciphertext !== expectedRefresh) {
            return { success: true, meta: { changes: 0 } };
          }
          missingScopesJson = String(missingScopes);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE bot_identity") && sql.includes("SET access_token_ciphertext")) {
          tokenWriteAttempts += 1;
          if (options.failTokenWriteOnce && tokenWriteAttempts === 1) throw new Error("D1 write failed");
          if (options.beforeTokenWrite && tokenWriteAttempts === 1) await options.beforeTokenWrite();
          const [access, refresh, expires, updated, expectedAccess, expectedRefresh] = values;
          if (identity.access_token_ciphertext !== expectedAccess ||
              identity.refresh_token_ciphertext !== expectedRefresh) {
            return { success: true, meta: { changes: 0 } };
          }
          identity = {
            access_token_ciphertext: String(access),
            refresh_token_ciphertext: String(refresh),
            expires_at: String(expires),
            updated_at: String(updated),
          };
          successfulTokenWrites += 1;
          options.onSuccessfulTokenWrite?.();
          if (options.failTokenWriteAfterCommitOnce && tokenWriteAttempts === 1) {
            throw new Error("D1 response lost after commit");
          }
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE bot_identity_status") && sql.includes("SET status = 'connected'")) {
          identityStatus = {
            status: "connected",
            reason: null,
            updated_at: String(values[0]),
          };
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE bot_identity_status") && sql.includes("access_token_ciphertext")) {
          const [nextStatus, reason, updatedAt, expectedAccess, expectedRefresh] = values;
          if (identityStatus.status === "revoked" ||
              identity.access_token_ciphertext !== expectedAccess ||
              identity.refresh_token_ciphertext !== expectedRefresh) {
            return { success: true, meta: { changes: 0 } };
          }
          identityStatus = {
            status: nextStatus as "connected" | "revoked" | "error",
            reason: reason as string | null,
            updated_at: String(updatedAt),
          };
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO bot_identity_status")) {
          identityStatus = {
            status: values[1] as "connected" | "revoked" | "error",
            reason: values[2] as string | null,
            updated_at: String(values[3]),
          };
        }
        return { success: true, meta: { changes: 1 } };
      }),
    };
    return statement;
  });
  const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  });
  const database = { prepare, batch } as unknown as D1Database;
  return {
    environment: { ...environment, DB: database } as unknown as Env,
    prepare,
    bind,
    getTokenWriteAttempts: () => tokenWriteAttempts,
    getSuccessfulTokenWrites: () => successfulTokenWrites,
    read: () => identity,
    readStatus: () => identityStatus,
    readMissingScopes: () => JSON.parse(missingScopesJson) as string[],
    getInitialAccessTokenCiphertext: () => initialAccessTokenCiphertext,
    getInitialRefreshTokenCiphertext: () => initialRefreshTokenCiphertext,
  };
};

const requestedUrls = (fetcher: ReturnType<typeof vi.fn>): string[] =>
  fetcher.mock.calls.map((call: unknown[]) => String(call[0]));

describe("bot maintenance", () => {
  it("records the missing bot scopes during the maintenance run", async () => {
    const granted = [BOT_SCOPES[0], BOT_SCOPES[2]];
    const { environment: env, readMissingScopes } = await makeMaintenanceEnvironment(
      "2026-09-18T02:00:01.000Z",
      "connected",
      { scopes: granted },
    );
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(readMissingScopes()).toEqual(missingBotScopes(granted));
  });

  it("treats an unparseable database expiry value as close to expiry", () => {
    expect(shouldRefreshBotToken("kein-datum", "2026-09-18T00:00:00.000Z")).toBe(true);
  });

  it("only refreshes tokens that expire in less than an hour", () => {
    expect(shouldRefreshBotToken("2026-09-18T00:59:59.000Z", "2026-09-18T00:00:00.000Z")).toBe(true);
    expect(shouldRefreshBotToken("2026-09-18T01:00:01.000Z", "2026-09-18T00:00:00.000Z")).toBe(false);
  });

  it("exchanges a refresh token for both new tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }),
      { status: 200 },
    ));

    await expect(refreshBotToken(fetcher, environment, "refresh-alt")).resolves.toEqual({
      accessToken: "access-neu",
      refreshToken: "refresh-neu",
      expiresIn: 7200,
      scopes: [],
    });
    expect(fetcher).toHaveBeenCalledWith("https://id.twitch.tv/oauth2/token", expect.objectContaining({ method: "POST" }));
  });

  it("adopts the Twitch error code from the refresh response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "invalid_client" }),
      { status: 400 },
    ));

    await expect(refreshBotToken(fetcher, environment, "refresh-alt")).rejects.toMatchObject({
      status: 400,
      code: "invalid_client",
    });
  });

  it("validates an access token via Twitch", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ client_id: "client-id", user_id: "bot-user", login: "brobot", expires_in: 3600, scopes: [] }),
      { status: 200 },
    ));

    await expect(validateBotToken(fetcher, environment, "access-token")).resolves.toEqual({
      userId: "bot-user",
      login: "brobot",
      expiresIn: 3600,
      scopes: [],
    });
  });

  it("reads the channels where the bot is a moderator", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ broadcaster_id: "channel-1" }, { broadcaster_id: "channel-2" }] }),
      { status: 200 },
    ));

    await expect(fetchModeratedChannels(fetcher, environment.TWITCH_CLIENT_ID, "bot-user", "access-token"))
      .resolves.toEqual(["channel-1", "channel-2"]);
  });

  it("reads all pages of the moderator channel query", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          data: [{ broadcaster_id: "channel-1" }],
          pagination: { cursor: "cursor-1" },
        }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ data: [{ broadcaster_id: "channel-2" }], pagination: {} }),
        { status: 200 },
      ));

    await expect(fetchModeratedChannels(fetcher, environment.TWITCH_CLIENT_ID, "bot-user", "access-token"))
      .resolves.toEqual(["channel-1", "channel-2"]);
    expect(fetcher.mock.calls[1]?.[0]).toContain("after=cursor-1");
  });

  it("doesn't call the refresh endpoint when expiry is far away", async () => {
    const { environment: env } = await makeMaintenanceEnvironment("2026-09-18T02:00:01.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(requestedUrls(fetcher)).not.toContain("https://id.twitch.tv/oauth2/token");
  });

  it("refreshes a soon-expiring bot and writes both ciphertexts", async () => {
    const {
      environment: env,
      read,
      getInitialAccessTokenCiphertext,
      getInitialRefreshTokenCiphertext,
    } = await makeMaintenanceEnvironment("2026-09-18T00:59:59.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(requestedUrls(fetcher)).toContain("https://id.twitch.tv/oauth2/token");
    expect(read().access_token_ciphertext).not.toBe(getInitialAccessTokenCiphertext());
    expect(read().refresh_token_ciphertext).not.toBe(getInitialRefreshTokenCiphertext());
    expect(read().updated_at).toBe("2026-09-18T00:00:00.000Z");
  });

  it("retries a failed D1 write after a successful Twitch refresh", async () => {
    const { environment: env, getTokenWriteAttempts } = await makeMaintenanceEnvironment(
      "2026-09-18T00:59:59.000Z",
      "connected",
      { failTokenWriteOnce: true },
    );
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(getTokenWriteAttempts()).toBe(2);
    expect(requestedUrls(fetcher)).toContain("https://api.twitch.tv/helix/moderation/channels?user_id=bot-user&first=100");
  });

  it("keeps an already-written token when the D1 response is lost", async () => {
    const {
      environment: env,
      read,
      readStatus,
      getInitialAccessTokenCiphertext,
      getInitialRefreshTokenCiphertext,
      getTokenWriteAttempts,
    } = await makeMaintenanceEnvironment(
      "2026-09-18T00:59:59.000Z",
      "connected",
      { failTokenWriteAfterCommitOnce: true },
    );
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(getTokenWriteAttempts()).toBe(2);
    expect(read().access_token_ciphertext).not.toBe(getInitialAccessTokenCiphertext());
    expect(read().refresh_token_ciphertext).not.toBe(getInitialRefreshTokenCiphertext());
    expect(readStatus().status).toBe("connected");
  });

  it("handles two parallel refresh runs with one CAS winner", async () => {
    const { environment: env, readStatus, getSuccessfulTokenWrites } = await makeMaintenanceEnvironment(
      "2026-09-18T00:59:59.000Z",
    );
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return Promise.resolve(new Response(
          JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }),
          { status: 200 },
        ));
      }
      if (url === "https://id.twitch.tv/oauth2/token") {
        return Promise.resolve(new Response(
          JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }),
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));
    });

    await Promise.all([
      maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher),
      maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher),
    ]);

    expect(fetcher.mock.calls.filter((call: unknown[]) => call[0] === "https://id.twitch.tv/oauth2/token")).toHaveLength(2);
    expect(getSuccessfulTokenWrites()).toBe(1);
    expect(readStatus().status).toBe("connected");
    expect(readStatus().reason).toBeNull();
  });

  it("tries the valid refresh once for an expired access token", async () => {
    const { environment: env } = await makeMaintenanceEnvironment("2026-09-17T23:59:59.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Invalid OAuth token" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(requestedUrls(fetcher)).toContain("https://id.twitch.tv/oauth2/token");
  });

  it("also refreshes exactly once after a 401 when expiry is still far away", async () => {
    const { environment: env, read, readStatus } = await makeMaintenanceEnvironment("2026-09-18T02:00:01.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Invalid OAuth token" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(requestedUrls(fetcher).filter((url) => url === "https://id.twitch.tv/oauth2/token")).toHaveLength(1);
    expect(read().expires_at).toBe("2026-09-18T02:00:00.000Z");
    expect(readStatus().status).toBe("connected");
  });

  it("sets revoked on a fresh 401 only after the refresh has failed", async () => {
    const { environment: env, readStatus } = await makeMaintenanceEnvironment("2026-09-18T02:00:01.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Invalid OAuth token" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readStatus().status).toBe("revoked");
    expect(readStatus().reason).toBe("authorization_revoked");
  });

  it("lets a successful rotation stand despite a parallel status update", async () => {
    const { environment: env, read, readStatus } = await makeMaintenanceEnvironment("2026-09-18T00:59:59.000Z");
    let releaseValidation!: (response: Response) => void;
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
    const validation = new Promise<Response>((resolve) => { releaseValidation = resolve; });
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        markValidationStarted();
        return validation;
      }
      if (url === "https://id.twitch.tv/oauth2/token") {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));
    });
    const maintenance = maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);
    await validationStarted;
    await setBotIdentityStatus(env.DB, "error", "temporary", "2026-09-18T00:00:01.000Z");
    releaseValidation(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }));
    await maintenance;

    expect(read().expires_at).toBe("2026-09-18T02:00:00.000Z");
    expect(readStatus().status).toBe("connected");
  });

  it("leaves the successful token state standing when a parallel stale run gets invalid_grant", async () => {
    let markRotationCommitted!: () => void;
    const rotationCommitted = new Promise<void>((resolve) => { markRotationCommitted = resolve; });
    const { environment: env, read, readStatus, getInitialAccessTokenCiphertext } = await makeMaintenanceEnvironment(
      "2026-09-18T00:59:59.000Z",
      "connected",
      { onSuccessfulTokenWrite: markRotationCommitted },
    );
    let refreshCalls = 0;
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return Promise.resolve(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }));
      }
      if (url === "https://id.twitch.tv/oauth2/token") {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }));
        }
        return rotationCommitted.then(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));
    });

    await Promise.all([
      maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher),
      maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher),
    ]);

    expect(refreshCalls).toBe(2);
    expect(read().access_token_ciphertext).not.toBe(getInitialAccessTokenCiphertext());
    expect(readStatus().status).toBe("connected");
    expect(readStatus().reason).toBeNull();
  });

  it("doesn't permanently set the bot to revoked on an invalid_grant that arrives before the save", async () => {
    let releaseTokenWrite!: () => void;
    let markTokenWriteStarted!: () => void;
    const tokenWriteStarted = new Promise<void>((resolve) => { markTokenWriteStarted = resolve; });
    const tokenWrite = new Promise<void>((resolve) => { releaseTokenWrite = resolve; });
    const { environment: env, read, readStatus } = await makeMaintenanceEnvironment(
      "2026-09-18T00:59:59.000Z",
      "connected",
      {
        beforeTokenWrite: async () => {
          markTokenWriteStarted();
          await tokenWrite;
        },
      },
    );
    let refreshCalls = 0;
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return Promise.resolve(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }));
      }
      if (url.startsWith("https://api.twitch.tv/helix/moderation/channels")) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));
      }
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    });

    const successfulRun = maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);
    await tokenWriteStarted;
    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);
    releaseTokenWrite();
    await successfulRun;

    expect(refreshCalls).toBe(2);
    expect(read().access_token_ciphertext).not.toBe("access-alt");
    expect(readStatus().status).toBe("connected");
    expect(readStatus().reason).toBeNull();
  });

  it("doesn't let an already-running success path set revoked back to connected", async () => {
    const { environment: env, readStatus } = await makeMaintenanceEnvironment("2026-09-18T02:00:01.000Z");
    let releaseModeration!: (response: Response) => void;
    let markModerationStarted!: () => void;
    const moderationStarted = new Promise<void>((resolve) => { markModerationStarted = resolve; });
    const moderation = new Promise<Response>((resolve) => { releaseModeration = resolve; });
    let validateCalls = 0;
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        validateCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 7200 }), { status: 200 }));
      }
      if (url === "https://api.twitch.tv/helix/moderation/channels?user_id=bot-user&first=100") {
        markModerationStarted();
        return moderation;
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));
    });
    const maintenance = maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);
    await moderationStarted;
    await setBotIdentityStatus(env.DB, "revoked", "authorization_revoked", "2026-09-18T00:00:01.000Z");
    releaseModeration(new Response(JSON.stringify({ data: [{ broadcaster_id: "channel-1" }] }), { status: 200 }));
    await maintenance;

    expect(validateCalls).toBe(1);
    expect(readStatus().status).toBe("revoked");
  });

  it("marks a rejected refresh as revoked and doesn't keep retrying forever", async () => {
    const { environment: env } = await makeMaintenanceEnvironment("2026-09-18T00:59:59.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestedUrls(fetcher)).not.toContain("https://api.twitch.tv/helix/moderation/channels?user_id=bot-user");
  });

  it("also permanently ends a refresh rejected with 401", async () => {
    const { environment: env, readStatus } = await makeMaintenanceEnvironment("2026-09-18T00:59:59.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readStatus()).toEqual({
      status: "revoked",
      reason: "authorization_revoked",
      updated_at: "2026-09-18T00:00:00.000Z",
    });
  });

  it("treats invalid_client as only temporary, even with a 400", async () => {
    const { environment: env, readStatus } = await makeMaintenanceEnvironment("2026-09-18T00:59:59.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "bot-user", login: "brobot", expires_in: 3599 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }));

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(readStatus()).toEqual({
      status: "error",
      reason: "invalid_client",
      updated_at: "2026-09-18T00:00:00.000Z",
    });
  });

  it("skips an already-revoked bot until it's reauthorized", async () => {
    const { environment: env } = await makeMaintenanceEnvironment("2026-09-18T00:59:59.000Z", "revoked");
    const fetcher = vi.fn();

    await maintainBotIdentity(env, "2026-09-18T00:00:00.000Z", fetcher);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs the hourly handler via waitUntil", async () => {
    const { environment: env } = await makeMaintenanceEnvironment("2026-09-18T02:00:01.000Z");
    const waitUntil = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/token") {
        return Promise.resolve(new Response(
          JSON.stringify({ access_token: "app-access", expires_in: 7200 }),
          { status: 200 },
        ));
      }
      return Promise.resolve(new Response(
        JSON.stringify(url.includes("/users")
          ? { user_id: "bot-user", login: "brobot", expires_in: 7200 }
          : { data: [{ broadcaster_id: "channel-1" }] }),
        { status: 200 },
      ));
    }));

    await scheduled(
      {} as ScheduledController,
      env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
