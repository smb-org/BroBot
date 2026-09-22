import { describe, expect, it, vi } from "vitest";

import {
  consumeOAuthTransaction,
  createOAuthTransaction,
  failOAuthTransaction,
  purgeExpiredOAuthTransactions,
} from "../../src/worker/db/oauth-transactions";
import {
  actorGuard,
  platformSessionGuard,
  requiredActorRoles,
} from "../../src/worker/db/guards";
import {
  createChannelMemberWithAudit,
  deleteChannelMemberWithAudit,
  updateChannelMemberWithAudit,
} from "../../src/worker/db/channel-members";
import {
  createSession,
  getSession,
  revokeSession,
} from "../../src/worker/db/sessions";
import {
  getBotIdentity,
  getBotIdentityStatus,
  rotateBotTokens as rotateBotTokensBase,
  setBotIdentityStatusIfCurrent,
  setBotIdentityStatus,
  upsertBotIdentity,
  upsertBotIdentityAndStatus,
} from "../../src/worker/db/bot-identity";
import {
  getAppAccessToken,
  rotateAppAccessToken,
} from "../../src/worker/db/app-token";
import {
  getLoginIdentity,
  listLoginIdentities,
  revokeLoginIdentityAndSessionsForUser,
  rotateLoginTokensForUser,
  setLoginIdentityStatus,
  setLoginIdentityTokenScopes,
  upsertLoginIdentity,
} from "../../src/worker/db/login-identity";
import {
  listChannelIds,
} from "../../src/worker/db/channels";
import {
  setBotChannelStatus,
  getBotChannelStatusCheckLock,
  releaseBotChannelStatusCheck,
  tryReserveBotChannelStatusCheck,
} from "../../src/worker/db/bot-channel-status";
import type {
  ActorContext,
} from "../../src/worker/db/guards";
import type {
  ChannelMemberRecord,
} from "../../src/worker/db/channel-members";
import { MANAGING_ROLES } from "../../src/contracts/values";
import { insertAppAccessToken } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const fakeDatabase = (firstResult: unknown = null, allResult: unknown = { results: [{ channel_id: "channel-1" }] }) => {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue(allResult),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  return {
    database: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
    statement,
  };
};

const freshTimestamp = (): string => new Date().toISOString();

const timestampWithInterval = (timestamp: string, abstandMs: number): string =>
  new Date(Date.parse(timestamp) + abstandMs).toISOString();

// Test fixtures: seed the raw state directly via SQL, because the rotation
// and CAS tests check exactly the rows that create a real precondition —
// not what the repository functions themselves would write. Only
// incidentals (user/login names, empty scopes) live as defaults in the
// helper; status, ciphertexts, and timestamps are always passed explicitly
// at the call site, because those are what each test is actually about.

interface BotIdentityFixture {
  userId: string;
  login: string;
  scopesJson: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

const seedBotIdentity = async (
  database: TestD1Database,
  overrides: Partial<BotIdentityFixture> = {},
): Promise<void> => {
  const identity: BotIdentityFixture = {
    userId: "bot-user",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: "access-alt",
    refreshTokenCiphertext: "refresh-alt",
    expiresAt: "2026-09-18T01:00:00.000Z",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    identity.userId,
    identity.login,
    identity.scopesJson,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    identity.expiresAt,
    identity.createdAt,
    identity.updatedAt,
  ).run();
};

const seedBotIdentityStatus = async (
  database: TestD1Database,
  status: string,
  reason: string | null,
  updatedAt: string,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO bot_identity_status (id, status, reason, updated_at)
     VALUES (1, ?, ?, ?)`,
  ).bind(status, reason, updatedAt).run();
};

interface LoginIdentityFixture {
  userId: string;
  login: string;
  scopesJson: string;
  tokenScopesJson: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  status: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

const seedLoginIdentity = async (
  database: TestD1Database,
  overrides: Partial<LoginIdentityFixture> = {},
): Promise<void> => {
  const identity: LoginIdentityFixture = {
    userId: "user-1",
    login: "tester",
    scopesJson: "[]",
    tokenScopesJson: "[]",
    accessTokenCiphertext: "access-alt",
    refreshTokenCiphertext: "refresh-alt",
    expiresAt: "2026-09-19T00:00:00.000Z",
    status: "connected",
    reason: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, token_scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    identity.userId,
    identity.login,
    identity.scopesJson,
    identity.tokenScopesJson,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    identity.expiresAt,
    identity.status,
    identity.reason,
    identity.createdAt,
    identity.updatedAt,
  ).run();
};

interface SessionFixture {
  sessionId: string;
  userId: string;
  login: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
}

const seedSession = async (
  database: TestD1Database,
  overrides: Partial<SessionFixture> = {},
): Promise<void> => {
  const session: SessionFixture = {
    sessionId: "session-1",
    userId: "user-1",
    login: "tester",
    expiresAt: "2026-09-19T00:00:00.000Z",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    revokedAt: null,
    revocationReason: null,
    ...overrides,
  };
  await database.prepare(
    `INSERT INTO auth_sessions
      (session_id, user_id, login, expires_at, created_at, updated_at, revoked_at, revocation_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    session.sessionId,
    session.userId,
    session.login,
    session.expiresAt,
    session.createdAt,
    session.updatedAt,
    session.revokedAt,
    session.revocationReason,
  ).run();
};

const seedChannel = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    channelId,
    channelId,
    channelId,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const seedChannelMember = async (
  database: TestD1Database,
  member: ChannelMemberRecord,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    member.channelId,
    member.userId,
    member.role,
    member.createdAt,
    member.updatedAt,
  ).run();
};

const memberFor = (
  channelId: string,
  userId: string,
  role: ChannelMemberRecord["role"],
): ChannelMemberRecord => ({
  channelId,
  userId,
  role,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
});

interface GuardActorFixture {
  actor: ActorContext;
  channelId: string;
  role: ChannelMemberRecord["role"];
  identityStatus?: string;
  sessionExpiresAt: string;
  revokedAt?: string | null;
}

const seedGuardActor = async (
  database: TestD1Database,
  fixture: GuardActorFixture,
): Promise<void> => {
  await seedChannel(database, fixture.channelId);
  await seedLoginIdentity(database, {
    userId: fixture.actor.userId,
    login: fixture.actor.userId,
    status: fixture.identityStatus ?? "connected",
  });
  await seedSession(database, {
    sessionId: fixture.actor.sessionId,
    userId: fixture.actor.userId,
    login: fixture.actor.userId,
    expiresAt: fixture.sessionExpiresAt,
    revokedAt: fixture.revokedAt ?? null,
  });
  await seedChannelMember(database, {
    channelId: fixture.channelId,
    userId: fixture.actor.userId,
    role: fixture.role,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  });
};

const readChannelMember = async (
  database: TestD1Database,
  channelId: string,
  userId: string,
): Promise<ChannelMemberRecord | null> => {
  const row = await database.prepare(
    `SELECT channel_id, user_id, role, created_at, updated_at
       FROM channel_members
      WHERE channel_id = ? AND user_id = ?`,
  ).bind(channelId, userId).first<{
    channel_id: string;
    user_id: string;
    role: ChannelMemberRecord["role"];
    created_at: string;
    updated_at: string;
  }>();
  return row === null ? null : {
    channelId: row.channel_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/**
 * Common flow for all actorGuard rejection tests: create the database, seed
 * the initial state, call a mutating repository function under an actor,
 * verify the rejection, and prove the final state is unchanged. The one
 * attack variant that makes up each test — role, channel, timestamp, target
 * end state — lives entirely in `aufbau`, `mutation`, and `checkFinalState`
 * at the respective call site.
 */
const expectRejectedGuardMutation = async (
  aufbau: (database: TestD1Database, jetzt: string) => Promise<void>,
  mutation: (database: D1Database, jetzt: string) => Promise<boolean>,
  checkFinalState: (database: TestD1Database) => Promise<void>,
): Promise<void> => {
  const database = new TestD1Database();
  const jetzt = freshTimestamp();
  try {
    await aufbau(database, jetzt);
    await expect(mutation(database as unknown as D1Database, jetzt)).resolves.toBe(false);
    await checkFinalState(database);
  } finally {
    database.close();
  }
};

// Thin wrappers around the rotation calls: named fields instead of long
// positional argument lists, so the call site makes clear which value is the
// expected (CAS) current state and which is the new target state.

interface RotateBotTokensFields {
  expectedAccessTokenCiphertext: string;
  expectedRefreshTokenCiphertext: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  updatedAt: string;
}

const rotateBotTokens = (
  database: D1Database,
  felder: RotateBotTokensFields,
): Promise<boolean> => rotateBotTokensBase(
  database,
  felder.expectedAccessTokenCiphertext,
  felder.expectedRefreshTokenCiphertext,
  felder.accessTokenCiphertext,
  felder.refreshTokenCiphertext,
  felder.expiresAt,
  felder.updatedAt,
);

interface RotateLoginTokensFields {
  userId: string;
  expectedAccessTokenCiphertext: string;
  expectedRefreshTokenCiphertext: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  updatedAt: string;
  expectedUpdatedAt: string;
}

const rotateLoginTokens = (
  database: D1Database,
  felder: RotateLoginTokensFields,
): Promise<boolean> => rotateLoginTokensForUser(
  database,
  felder.userId,
  felder.expectedAccessTokenCiphertext,
  felder.expectedRefreshTokenCiphertext,
  felder.accessTokenCiphertext,
  felder.refreshTokenCiphertext,
  felder.expiresAt,
  felder.updatedAt,
  felder.expectedUpdatedAt,
);

describe("auth D1 repository", () => {
  it("creates a traceable session and reads it back", async () => {
    const database = new TestD1Database();
    const record = {
      sessionId: "session-1",
      userId: "user-1",
      login: "tester",
      expiresAt: "2026-09-19T00:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
      revokedAt: null,
      revocationReason: null,
    };

    try {
      await createSession(database as unknown as D1Database, record);
      await expect(getSession(database as unknown as D1Database, "session-1")).resolves.toEqual(record);
    } finally {
      database.close();
    }
  });

  it("consumes an OAuth transaction only once, based on the stored state", async () => {
    const database = new TestD1Database();
    try {
      const transaction = {
        transactionId: "transaction-1",
        purpose: "login" as const,
        expiresAt: "2026-09-18T00:05:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
      };
      await createOAuthTransaction(database as unknown as D1Database, transaction);
      await expect(consumeOAuthTransaction(database as unknown as D1Database, "transaction-1", "2026-09-18T00:01:00.000Z"))
        .resolves.toEqual(transaction);
      await expect(consumeOAuthTransaction(database as unknown as D1Database, "transaction-1", "2026-09-18T00:01:01.000Z"))
        .resolves.toBeNull();
      await expect(database.prepare(
        "SELECT used_at FROM oauth_transactions WHERE transaction_id = ?",
      ).bind("transaction-1").first()).resolves.toEqual({ used_at: "2026-09-18T00:01:00.000Z" });
    } finally {
      database.close();
    }
  });

  it("doesn't consume an OAuth transaction with an unparseable expiry value", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO oauth_transactions (transaction_id, purpose, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(
        "transaction-ungültig",
        "login",
        "kein-datum",
        "2026-09-18T00:00:00.000Z",
      ).run();

      await expect(consumeOAuthTransaction(
        database as unknown as D1Database,
        "transaction-ungültig",
        "2026-09-18T00:01:00.000Z",
      )).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it("records the cause of a failed OAuth callback", async () => {
    const database = new TestD1Database();
    try {
      await createOAuthTransaction(database as unknown as D1Database, {
        transactionId: "transaction-1",
        purpose: "login",
        expiresAt: "2026-09-18T00:05:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
      });
      await consumeOAuthTransaction(database as unknown as D1Database, "transaction-1", "2026-09-18T00:01:00.000Z");
      await failOAuthTransaction(database as unknown as D1Database, "transaction-1", "code_exchange_rejected");

      await expect(database.prepare(
        "SELECT failure_reason FROM oauth_transactions WHERE transaction_id = ?",
      ).bind("transaction-1").first()).resolves.toEqual({ failure_reason: "code_exchange_rejected" });
    } finally {
      database.close();
    }
  });

  it("stores and revokes a session traceably", async () => {
    const database = new TestD1Database();
    try {
      const record = {
        sessionId: "session-1",
        userId: "user-1",
        login: "tester",
        expiresAt: "2026-09-19T00:00:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      };
      await createSession(database as unknown as D1Database, record);
      await revokeSession(database as unknown as D1Database, "session-1", "2026-09-18T01:00:00.000Z", "logout");

      await expect(getSession(database as unknown as D1Database, "session-1")).resolves.toMatchObject({
        ...record,
        revokedAt: "2026-09-18T01:00:00.000Z",
        revocationReason: "logout",
        updatedAt: "2026-09-18T01:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("creates an OAuth transaction", async () => {
    const database = new TestD1Database();
    try {
      await createOAuthTransaction(database as unknown as D1Database, {
        transactionId: "transaction-1",
        purpose: "bot",
        expiresAt: "2026-09-18T00:05:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
        expectedUserId: "user-1",
      });

      await expect(database.prepare(
        "SELECT transaction_id, purpose, expires_at, created_at, used_at, expected_user_id FROM oauth_transactions",
      ).first()).resolves.toEqual({
        transaction_id: "transaction-1",
        purpose: "bot",
        expires_at: "2026-09-18T00:05:00.000Z",
        created_at: "2026-09-18T00:00:00.000Z",
        used_at: null,
        expected_user_id: "user-1",
      });
    } finally {
      database.close();
    }
  });

  it("reads the global bot identity from the single-row table", async () => {
    const { database } = fakeDatabase({
      id: 1,
      user_id: "bot-user",
      login: "brobot",
      scopes_json: "[\"user:bot\"]",
      access_token_ciphertext: "access-ciphertext",
      refresh_token_ciphertext: "refresh-ciphertext",
      expires_at: "2026-09-18T02:00:00.000Z",
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
    });

    await expect(getBotIdentity(database)).resolves.toEqual({
      id: 1,
      userId: "bot-user",
      login: "brobot",
      scopesJson: "[\"user:bot\"]",
      accessTokenCiphertext: "access-ciphertext",
      refreshTokenCiphertext: "refresh-ciphertext",
      expiresAt: "2026-09-18T02:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
  });

  it("stores login tokens separately from the session and lists them", async () => {
    const database = new TestD1Database();
    const identity = {
      userId: "user-1",
      login: "tester",
      scopesJson: "[\"user:read:moderated_channels\"]",
      tokenScopesJson: "[\"user:read:moderated_channels\"]",
      accessTokenCiphertext: "access-ciphertext",
      refreshTokenCiphertext: "refresh-ciphertext",
      expiresAt: "2026-09-18T02:00:00.000Z",
      status: "connected" as const,
      reason: null,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    };

    try {
      await createSession(database as unknown as D1Database, {
        sessionId: "session-1",
        userId: "user-1",
        login: "tester",
        expiresAt: "2099-09-19T00:00:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });
      await upsertLoginIdentity(database as unknown as D1Database, identity);
      await expect(getLoginIdentity(database as unknown as D1Database, "user-1")).resolves.toEqual(identity);
      await expect(listLoginIdentities(database as unknown as D1Database, "2026-09-18T01:00:00.000Z"))
        .resolves.toEqual([identity]);
    } finally {
      database.close();
    }
  });

  it("discards stale token scopes after an intervening login rotation", async () => {
    const database = new TestD1Database();
    try {
      await seedLoginIdentity(database, { tokenScopesJson: "[\"aktuell\"]" });
      await database.prepare(
        `UPDATE twitch_login_identity
            SET access_token_ciphertext = 'access-neu', refresh_token_ciphertext = 'refresh-neu'
          WHERE user_id = 'user-1'`,
      ).run();

      await setLoginIdentityTokenScopes(
        database as unknown as D1Database,
        "user-1",
        "[\"veraltet\"]",
        "2026-09-18T01:00:00.000Z",
        "access-alt",
        "refresh-alt",
      );

      await expect(database.prepare(
        "SELECT token_scopes_json FROM twitch_login_identity WHERE user_id = 'user-1'",
      ).first()).resolves.toEqual({ token_scopes_json: '["aktuell"]' });
    } finally {
      database.close();
    }
  });

  it("doesn't refill token scopes after a concurrent revocation", async () => {
    const database = new TestD1Database();
    try {
      await seedLoginIdentity(database, { tokenScopesJson: "[\"aktuell\"]" });
      await setLoginIdentityStatus(
        database as unknown as D1Database,
        "user-1",
        "revoked",
        "authorization_revoked",
        "2026-09-18T01:00:00.000Z",
      );

      await setLoginIdentityTokenScopes(
        database as unknown as D1Database,
        "user-1",
        "[\"veraltet\"]",
        "2026-09-18T01:01:00.000Z",
        "access-alt",
        "refresh-alt",
      );

      await expect(database.prepare(
        "SELECT token_scopes_json FROM twitch_login_identity WHERE user_id = 'user-1'",
      ).first()).resolves.toEqual({ token_scopes_json: "[]" });
    } finally {
      database.close();
    }
  });

  it("updates the bot identity via id = 1", async () => {
    const database = new TestD1Database();
    try {
      await upsertBotIdentity(database as unknown as D1Database, {
        id: 1,
        userId: "bot-user",
        login: "brobot",
        scopesJson: "[\"user:bot\"]",
        accessTokenCiphertext: "access-ciphertext",
        refreshTokenCiphertext: "refresh-ciphertext",
        expiresAt: "2026-09-18T02:00:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });

      await expect(getBotIdentity(database as unknown as D1Database)).resolves.toMatchObject({
        userId: "bot-user",
        accessTokenCiphertext: "access-ciphertext",
        refreshTokenCiphertext: "refresh-ciphertext",
      });
    } finally {
      database.close();
    }
  });

  it("records the global connection status with a cause", async () => {
    const database = new TestD1Database();
    try {
      await setBotIdentityStatus(database as unknown as D1Database, "revoked", "invalid_grant", "2026-09-18T03:00:00.000Z");

      await expect(getBotIdentityStatus(database as unknown as D1Database)).resolves.toEqual({
        status: "revoked",
        reason: "invalid_grant",
        updatedAt: "2026-09-18T03:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("reads and stores moderator status per channel", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        "channel-1",
        "channel-1",
        "Kanal 1",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      await setBotIdentityStatus(database as unknown as D1Database, "connected", null, "2026-09-18T03:00:00.000Z");
      await setBotChannelStatus(database as unknown as D1Database, "channel-1", true, "2026-09-18T03:00:00.000Z", null);

      await expect(getBotIdentityStatus(database as unknown as D1Database)).resolves.toEqual({
        status: "connected",
        reason: null,
        updatedAt: "2026-09-18T03:00:00.000Z",
      });
      await expect(database.prepare(
        "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
      ).bind("channel-1").first()).resolves.toEqual({
        is_moderator: 1,
        checked_at: "2026-09-18T03:00:00.000Z",
        reason: null,
      });
    } finally {
      database.close();
    }
  });

  it("returns the approved channel IDs for the moderator sync", async () => {
    const { database } = fakeDatabase();

    await expect(listChannelIds(database)).resolves.toEqual(["channel-1"]);
  });

  it("creates the global app token via CAS only once", async () => {
    const database = new TestD1Database();
    const db = database as unknown as D1Database;

    try {
      await expect(rotateAppAccessToken(
        db,
        null,
        "cipher-first",
        "2026-09-19T12:00:00.000Z",
        "2026-09-19T10:00:00.000Z",
        "2026-09-19T10:00:00.000Z",
      )).resolves.toBe(true);
      await expect(rotateAppAccessToken(
        db,
        null,
        "cipher-second",
        "2026-09-19T13:00:00.000Z",
        "2026-09-19T11:00:00.000Z",
        "2026-09-19T11:00:00.000Z",
      )).resolves.toBe(false);
      await expect(getAppAccessToken(db)).resolves.toMatchObject({
        accessTokenCiphertext: "cipher-first",
      });
    } finally {
      database.close();
    }
  });

  it("updates the app token only with the expected ciphertext", async () => {
    const database = new TestD1Database();
    const db = database as unknown as D1Database;

    try {
      await insertAppAccessToken(
        database,
        "cipher-old",
        "2026-09-19T10:00:00.000Z",
        "2026-09-18T10:00:00.000Z",
        "2026-09-18T10:00:00.000Z",
      );
      await expect(rotateAppAccessToken(
        db,
        "cipher-stale",
        "cipher-ignored",
        "2026-09-19T12:00:00.000Z",
        "2026-09-18T10:00:00.000Z",
        "2026-09-19T11:00:00.000Z",
      )).resolves.toBe(false);
      await expect(getAppAccessToken(db)).resolves.toMatchObject({
        accessTokenCiphertext: "cipher-old",
      });
      await expect(rotateAppAccessToken(
        db,
        "cipher-old",
        "cipher-new",
        "2026-09-19T12:00:00.000Z",
        "2026-09-18T10:00:00.000Z",
        "2026-09-19T11:00:00.000Z",
      )).resolves.toBe(true);
      await expect(getAppAccessToken(db)).resolves.toMatchObject({
        accessTokenCiphertext: "cipher-new",
      });
    } finally {
      database.close();
    }
  });

  it("cleans up expired OAuth transactions", async () => {
    const database = new TestD1Database();
    try {
      const insert = database.prepare(
        `INSERT INTO oauth_transactions
          (transaction_id, purpose, expires_at, created_at, used_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      await insert.bind("abgelaufen", "login", "2026-09-18T00:30:00.000Z", "2026-09-18T00:00:00.000Z", null).run();
      await insert.bind("aktiv", "login", "2026-09-18T02:00:00.000Z", "2026-09-18T00:00:00.000Z", null).run();
      await insert.bind("verbraucht-alt", "bot", "2026-09-18T02:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:30:00.000Z").run();
      await insert.bind("verbraucht-neu", "bot", "2026-09-18T02:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T01:00:01.000Z").run();

      await purgeExpiredOAuthTransactions(database as unknown as D1Database, "2026-09-18T01:00:00.000Z");

      await expect(database.prepare(
        "SELECT transaction_id FROM oauth_transactions ORDER BY transaction_id",
      ).all()).resolves.toMatchObject({
        results: [{ transaction_id: "aktiv" }, { transaction_id: "verbraucht-neu" }],
      });
    } finally {
      database.close();
    }
  });

  it("replaces the bot access token only once with the real SQLite CAS", async () => {
    const database = new TestD1Database();
    try {
      await seedBotIdentity(database);

      await expect(rotateBotTokens(database as unknown as D1Database, {
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-alt",
        expiresAt: "2026-09-18T02:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
      })).resolves.toBe(true);
      await expect(rotateBotTokens(database as unknown as D1Database, {
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-second",
        refreshTokenCiphertext: "refresh-alt",
        expiresAt: "2026-09-18T03:00:00.000Z",
        updatedAt: "2026-09-18T02:00:00.000Z",
      })).resolves.toBe(false);

      await expect(database.prepare(
        "SELECT access_token_ciphertext, refresh_token_ciphertext, expires_at, updated_at FROM bot_identity WHERE id = 1",
      ).first()).resolves.toEqual({
        access_token_ciphertext: "access-ciphertext-neu",
        refresh_token_ciphertext: "refresh-alt",
        expires_at: "2026-09-18T02:00:00.000Z",
        updated_at: "2026-09-18T01:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("doesn't change the bot status on a second rotation with a stale access ciphertext", async () => {
    const database = new TestD1Database();
    try {
      await seedBotIdentity(database);
      await seedBotIdentityStatus(database, "revoked", "authorization_revoked", "2026-09-18T02:00:00.000Z");

      await expect(rotateBotTokens(database as unknown as D1Database, {
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-ciphertext-neu",
        expiresAt: "2026-09-18T02:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
      })).resolves.toBe(true);
      await expect(rotateBotTokens(database as unknown as D1Database, {
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-second",
        refreshTokenCiphertext: "refresh-ciphertext-neu",
        expiresAt: "2026-09-18T03:00:00.000Z",
        updatedAt: "2026-09-18T03:00:00.000Z",
      })).resolves.toBe(false);

      await expect(database.prepare(
        "SELECT access_token_ciphertext, refresh_token_ciphertext FROM bot_identity WHERE id = 1",
      ).first()).resolves.toEqual({
        access_token_ciphertext: "access-ciphertext-neu",
        refresh_token_ciphertext: "refresh-ciphertext-neu",
      });
      await expect(database.prepare(
        "SELECT status, reason, updated_at FROM bot_identity_status WHERE id = 1",
      ).first()).resolves.toEqual({
        status: "revoked",
        reason: "authorization_revoked",
        updated_at: "2026-09-18T02:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("doesn't revoke an active session with a stale login access ciphertext", async () => {
    const database = new TestD1Database();
    try {
      await seedLoginIdentity(database, {
        status: "revoked",
        reason: "authorization_revoked",
        updatedAt: "2026-09-18T02:00:00.000Z",
      });
      await seedSession(database);

      await expect(rotateLoginTokens(database as unknown as D1Database, {
        userId: "user-1",
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-alt",
        expiresAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
        expectedUpdatedAt: "2026-09-18T00:00:00.000Z",
      })).resolves.toBe(true);
      await expect(revokeLoginIdentityAndSessionsForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "authorization_revoked",
        "2026-09-18T03:00:00.000Z",
      )).resolves.toBe(false);

      await expect(database.prepare(
        "SELECT status, reason, access_token_ciphertext, refresh_token_ciphertext, updated_at FROM twitch_login_identity WHERE user_id = 'user-1'",
      ).first()).resolves.toEqual({
        status: "revoked",
        reason: "authorization_revoked",
        access_token_ciphertext: "access-ciphertext-neu",
        refresh_token_ciphertext: "refresh-alt",
        updated_at: "2026-09-18T01:00:00.000Z",
      });
      await expect(database.prepare(
        "SELECT revoked_at, revocation_reason FROM auth_sessions WHERE session_id = 'session-1'",
      ).first()).resolves.toEqual({ revoked_at: null, revocation_reason: null });
    } finally {
      database.close();
    }
  });

  it("doesn't store a new access ciphertext on a second login rotation", async () => {
    const database = new TestD1Database();
    try {
      await seedLoginIdentity(database);

      await expect(rotateLoginTokens(database as unknown as D1Database, {
        userId: "user-1",
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-alt",
        expiresAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
        expectedUpdatedAt: "2026-09-18T00:00:00.000Z",
      })).resolves.toBe(true);
      await expect(rotateLoginTokens(database as unknown as D1Database, {
        userId: "user-1",
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-second",
        refreshTokenCiphertext: "refresh-alt",
        expiresAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-18T02:00:00.000Z",
        expectedUpdatedAt: "2026-09-18T01:00:00.000Z",
      })).resolves.toBe(false);

      await expect(database.prepare(
        "SELECT access_token_ciphertext, refresh_token_ciphertext, expires_at, updated_at FROM twitch_login_identity WHERE user_id = 'user-1'",
      ).first()).resolves.toEqual({
        access_token_ciphertext: "access-ciphertext-neu",
        refresh_token_ciphertext: "refresh-alt",
        expires_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-18T01:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("doesn't restore a session with a stale login access ciphertext", async () => {
    const database = new TestD1Database();
    try {
      await seedLoginIdentity(database);
      await seedSession(database, {
        updatedAt: "2026-09-18T02:00:00.000Z",
        revokedAt: "2026-09-18T02:00:00.000Z",
        revocationReason: "authorization_revoked",
      });

      await expect(rotateLoginTokens(database as unknown as D1Database, {
        userId: "user-1",
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-ciphertext-neu",
        expiresAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
        expectedUpdatedAt: "2026-09-18T00:00:00.000Z",
      })).resolves.toBe(true);
      await expect(rotateLoginTokens(database as unknown as D1Database, {
        userId: "user-1",
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-second",
        refreshTokenCiphertext: "refresh-ciphertext-neu",
        expiresAt: "2026-09-21T00:00:00.000Z",
        updatedAt: "2026-09-18T03:00:00.000Z",
        expectedUpdatedAt: "2026-09-18T01:00:00.000Z",
      })).resolves.toBe(false);

      await expect(database.prepare(
        "SELECT access_token_ciphertext, refresh_token_ciphertext FROM twitch_login_identity WHERE user_id = 'user-1'",
      ).first()).resolves.toEqual({
        access_token_ciphertext: "access-ciphertext-neu",
        refresh_token_ciphertext: "refresh-ciphertext-neu",
      });
      await expect(database.prepare(
        "SELECT revoked_at, revocation_reason FROM auth_sessions WHERE session_id = 'session-1'",
      ).first()).resolves.toEqual({
        revoked_at: "2026-09-18T02:00:00.000Z",
        revocation_reason: "authorization_revoked",
      });
    } finally {
      database.close();
    }
  });

  it("restores the successfully stored bot state after a delayed invalid_grant", async () => {
    const database = new TestD1Database();
    try {
      await seedBotIdentity(database);
      await seedBotIdentityStatus(database, "connected", null, "2026-09-18T00:00:00.000Z");

      await expect(setBotIdentityStatusIfCurrent(
        database as unknown as D1Database,
        "revoked",
        "authorization_revoked",
        "2026-09-18T00:00:01.000Z",
        "access-alt",
        "refresh-alt",
      )).resolves.toBe(true);
      await expect(rotateBotTokens(database as unknown as D1Database, {
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-neu",
        refreshTokenCiphertext: "refresh-neu",
        expiresAt: "2026-09-18T02:00:00.000Z",
        updatedAt: "2026-09-18T00:00:02.000Z",
      })).resolves.toBe(true);

      await expect(database.prepare(
        "SELECT status, reason FROM bot_identity_status WHERE id = 1",
      ).first()).resolves.toEqual({ status: "connected", reason: null });
    } finally {
      database.close();
    }
  });

  it("restores the login state and active sessions after a delayed invalid_grant", async () => {
    const database = new TestD1Database();
    try {
      await seedLoginIdentity(database, { expiresAt: "2026-09-18T01:00:00.000Z" });
      await seedSession(database);

      await expect(revokeLoginIdentityAndSessionsForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "authorization_revoked",
        "2026-09-18T00:00:01.000Z",
      )).resolves.toBe(true);
      await expect(rotateLoginTokens(database as unknown as D1Database, {
        userId: "user-1",
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-neu",
        refreshTokenCiphertext: "refresh-neu",
        expiresAt: "2026-09-18T02:00:00.000Z",
        updatedAt: "2026-09-18T00:00:02.000Z",
        expectedUpdatedAt: "2026-09-18T00:00:00.000Z",
      })).resolves.toBe(true);

      await expect(database.prepare(
        "SELECT status, reason, access_token_ciphertext FROM twitch_login_identity WHERE user_id = 'user-1'",
      ).first()).resolves.toEqual({ status: "connected", reason: null, access_token_ciphertext: "access-neu" });
      await expect(database.prepare(
        "SELECT revoked_at, revocation_reason FROM auth_sessions WHERE session_id = 'session-1'",
      ).first()).resolves.toEqual({ revoked_at: null, revocation_reason: null });
    } finally {
      database.close();
    }
  });

  it("doesn't overwrite a fresher moderator status with a delayed result", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('kanal-a', 'kanal-a', 'Kanal A', ?, ?)`,
      ).bind("2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
      await setBotChannelStatus(
        database as unknown as D1Database,
        "kanal-a",
        true,
        "2026-09-18T04:00:00.000Z",
        null,
      );
      await setBotChannelStatus(
        database as unknown as D1Database,
        "kanal-a",
        false,
        "2026-09-18T03:00:00.000Z",
        "moderator_entfernt",
      );

      await expect(database.prepare(
        "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ is_moderator: 1, checked_at: "2026-09-18T04:00:00.000Z", reason: null });
    } finally {
      database.close();
    }
  });

  it("releases a lock only with its owner", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('kanal-a', 'kanal-a', 'Kanal A', ?, ?)`,
      ).bind("2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
      const firstOwner = await tryReserveBotChannelStatusCheck(
        database as unknown as D1Database,
        "kanal-a",
        "2026-09-18T04:05:00.000Z",
        "2026-09-18T04:00:00.000Z",
        "2026-09-17T23:55:00.000Z",
      );
      const secondOwner = await tryReserveBotChannelStatusCheck(
        database as unknown as D1Database,
        "kanal-a",
        "2026-09-18T04:11:00.000Z",
        "2026-09-18T04:06:00.000Z",
        "2026-09-18T04:01:00.000Z",
      );

      expect(firstOwner).not.toBeNull();
      expect(secondOwner).not.toBeNull();
      await releaseBotChannelStatusCheck(database as unknown as D1Database, "kanal-a", firstOwner ?? "");
      await expect(getBotChannelStatusCheckLock(database as unknown as D1Database, "kanal-a"))
        .resolves.toBe("2026-09-18T04:11:00.000Z");
    } finally {
      database.close();
    }
  });

  it("runs identity and bot status in one atomic batch operation", async () => {
    const database = new TestD1Database();
    try {
      await seedBotIdentity(database, {
        accessTokenCiphertext: "alt-access",
        refreshTokenCiphertext: "alt-refresh",
        expiresAt: "2026-09-19T00:00:00.000Z",
      });
      await seedBotIdentityStatus(database, "revoked", "authorization_revoked", "2026-09-18T00:00:00.000Z");

      const failingDatabase = {
        prepare: database.prepare.bind(database),
        batch: (statements: TestPreparedStatement[]) => {
          const snapshot = database.sqlite.prepare(
            "SELECT access_token_ciphertext, refresh_token_ciphertext FROM bot_identity WHERE id = 1",
          ).get();
          try {
            statements[0]?.runSync();
            throw new Error("Status-Write fehlgeschlagen");
          } catch (error) {
            database.prepare(
              `UPDATE bot_identity
                  SET access_token_ciphertext = ?, refresh_token_ciphertext = ?
                WHERE id = 1`,
            ).bind(
              (snapshot as { access_token_ciphertext: string }).access_token_ciphertext,
              (snapshot as { refresh_token_ciphertext: string }).refresh_token_ciphertext,
            ).runSync();
            throw error;
          }
        },
      } as unknown as D1Database;

      await expect(upsertBotIdentityAndStatus(failingDatabase, {
        id: 1,
        userId: "bot-user",
        login: "brobot",
        scopesJson: "[]",
        accessTokenCiphertext: "neu-access",
        refreshTokenCiphertext: "neu-refresh",
        expiresAt: "2026-09-20T00:00:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
      }, "connected", null, "2026-09-18T01:00:00.000Z")).rejects.toThrow("Status-Write fehlgeschlagen");

      await expect(database.prepare(
        "SELECT access_token_ciphertext, refresh_token_ciphertext FROM bot_identity WHERE id = 1",
      ).first()).resolves.toEqual({ access_token_ciphertext: "alt-access", refresh_token_ciphertext: "alt-refresh" });
      await expect(database.prepare(
        "SELECT status, reason FROM bot_identity_status WHERE id = 1",
      ).first()).resolves.toEqual({ status: "revoked", reason: "authorization_revoked" });
    } finally {
      database.close();
    }
  });

  it("denies INSERT when the session belongs to a different user than the actor", () =>
    expectRejectedGuardMutation(
      (database, jetzt) => seedGuardActor(database, {
        actor: { userId: "user-b", sessionId: "session-b" },
        channelId: "kanal-a",
        role: "broadcaster",
        sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
      }),
      (database, jetzt) => createChannelMemberWithAudit(
        database,
        { userId: "user-a", sessionId: "session-b" },
        memberFor("kanal-a", "target-user", "operator"),
        "member.added",
        jetzt,
        actorGuard(MANAGING_ROLES),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toBeNull();
      },
    ));

  it("denies INSERT with a revoked session", () =>
    expectRejectedGuardMutation(
      (database, jetzt) => seedGuardActor(database, {
        actor: { userId: "user-1", sessionId: "session-1" },
        channelId: "kanal-a",
        role: "broadcaster",
        sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
        revokedAt: timestampWithInterval(jetzt, -1_000),
      }),
      (database, jetzt) => createChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        memberFor("kanal-a", "target-user", "operator"),
        "member.added",
        jetzt,
        actorGuard(MANAGING_ROLES),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toBeNull();
      },
    ));

  it("denies UPDATE with a revoked session", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "manager",
          sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
          revokedAt: timestampWithInterval(jetzt, -1_000),
        });
        await seedChannelMember(database, memberFor("kanal-a", "target-user", "operator"));
      },
      (database, jetzt) => updateChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        { ...memberFor("kanal-a", "target-user", "manager"), updatedAt: jetzt },
        "member.role_changed",
        jetzt,
        actorGuard(MANAGING_ROLES),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "operator" });
      },
    ));

  it("denies DELETE with a revoked session", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "manager",
          sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
          revokedAt: timestampWithInterval(jetzt, -1_000),
        });
        await seedChannelMember(database, memberFor("kanal-a", "target-user", "operator"));
      },
      (database, jetzt) => deleteChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        "kanal-a",
        "target-user",
        "member.removed",
        jetzt,
        actorGuard(MANAGING_ROLES),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "operator" });
      },
    ));

  it("denies UPDATE with an expired session", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "manager",
          sessionExpiresAt: timestampWithInterval(jetzt, -1_000),
        });
        await seedChannelMember(database, memberFor("kanal-a", "target-user", "operator"));
      },
      (database, jetzt) => updateChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        { ...memberFor("kanal-a", "target-user", "manager"), updatedAt: jetzt },
        "member.role_changed",
        jetzt,
        actorGuard(MANAGING_ROLES),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "operator" });
      },
    ));

  it("denies DELETE for a revoked Twitch identity", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "manager",
          identityStatus: "revoked",
          sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
        });
        await seedChannelMember(database, memberFor("kanal-a", "target-user", "operator"));
      },
      (database, jetzt) => deleteChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        "kanal-a",
        "target-user",
        "member.removed",
        jetzt,
        actorGuard(MANAGING_ROLES),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "operator" });
      },
    ));

  it("denies INSERT in a channel other than the actor's", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "broadcaster",
          sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
        });
        await seedChannel(database, "kanal-b");
      },
      (database, jetzt) => createChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        memberFor("kanal-b", "target-user", "operator"),
        "member.added",
        jetzt,
        actorGuard(MANAGING_ROLES),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-b", "target-user")).resolves.toBeNull();
      },
    ));

  it("denies INSERT for a role grant by a manager", () =>
    expectRejectedGuardMutation(
      (database, jetzt) => seedGuardActor(database, {
        actor: { userId: "user-1", sessionId: "session-1" },
        channelId: "kanal-a",
        role: "manager",
        sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
      }),
      (database, jetzt) => createChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        memberFor("kanal-a", "target-user", "broadcaster"),
        "member.added",
        jetzt,
        actorGuard(["broadcaster"]),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toBeNull();
      },
    ));

  it("denies UPDATE to broadcaster role by a manager", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "manager",
          sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
        });
        await seedChannelMember(database, memberFor("kanal-a", "target-user", "operator"));
      },
      (database, jetzt) => updateChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        { ...memberFor("kanal-a", "target-user", "broadcaster"), updatedAt: jetzt },
        "member.role_changed",
        jetzt,
        actorGuard(["broadcaster"]),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "operator" });
      },
    ));

  it("denies a SQL UPDATE demoting a broadcaster by a manager when there are multiple broadcasters", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "manager",
          sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
        });
        await seedChannelMember(database, memberFor("kanal-a", "broadcaster-1", "broadcaster"));
        await seedChannelMember(database, memberFor("kanal-a", "broadcaster-2", "broadcaster"));
      },
      (database, jetzt) => updateChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        { ...memberFor("kanal-a", "broadcaster-1", "manager"), updatedAt: jetzt },
        "member.role_changed",
        jetzt,
        actorGuard(requiredActorRoles("manager", "broadcaster")),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "broadcaster-1")).resolves.toMatchObject({ role: "broadcaster" });
      },
    ));

  it("denies a SQL DELETE of a broadcaster by a manager when there are multiple broadcasters", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "manager",
          sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
        });
        await seedChannelMember(database, memberFor("kanal-a", "broadcaster-1", "broadcaster"));
        await seedChannelMember(database, memberFor("kanal-a", "broadcaster-2", "broadcaster"));
      },
      (database, jetzt) => deleteChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        "kanal-a",
        "broadcaster-1",
        "member.removed",
        jetzt,
        actorGuard(requiredActorRoles(undefined, "broadcaster")),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "broadcaster-1")).resolves.toMatchObject({ role: "broadcaster" });
      },
    ));

  it("denies DELETE by a member without the manager role", () =>
    expectRejectedGuardMutation(
      async (database, jetzt) => {
        await seedGuardActor(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "operator",
          sessionExpiresAt: timestampWithInterval(jetzt, 60_000),
        });
        await seedChannelMember(database, memberFor("kanal-a", "target-user", "operator"));
      },
      (database, jetzt) => deleteChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        "kanal-a",
        "target-user",
        "member.removed",
        jetzt,
        actorGuard(MANAGING_ROLES),
      ),
      async (database) => {
        await expect(readChannelMember(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "operator" });
      },
    ));

  it("writes the operator as the actor into the audit log", async () => {
    const database = new TestD1Database();
    const jetzt = freshTimestamp();
    try {
      await seedChannel(database, "kanal-a");
      await seedLoginIdentity(database, { userId: "user-1", login: "betreiber" });
      await seedSession(database, {
        userId: "user-1",
        login: "betreiber",
        expiresAt: timestampWithInterval(jetzt, 60_000),
      });

      const actor = { userId: "user-1", sessionId: "session-1" };
      const changed = await createChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        memberFor("kanal-a", "target-user", "manager"),
        "operator.member.added",
        jetzt,
        platformSessionGuard(actor, jetzt),
        "platform_admin",
      );

      expect(changed).toBe(true);
      await expect(database.prepare(
        "SELECT actor_kind FROM audit_log WHERE action = ?",
      ).bind("operator.member.added").first()).resolves.toEqual({ actor_kind: "platform_admin" });
    } finally {
      database.close();
    }
  });
});
