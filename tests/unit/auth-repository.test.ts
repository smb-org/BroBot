import { describe, expect, it, vi } from "vitest";

import {
  consumeOAuthTransaction,
  createSession,
  createOAuthTransaction,
  failOAuthTransaction,
  getBotIdentity,
  getLoginIdentity,
  getBotIdentityStatus,
  getSession,
  listLoginIdentities,
  listChannelIds,
  revokeSession,
  revokeLoginIdentityAndSessionsForUser,
  purgeExpiredOAuthTransactions,
  rotateBotTokens,
  rotateLoginTokensForUser,
  setBotChannelStatus,
  setBotIdentityStatusIfCurrent,
  setBotIdentityStatus,
  getBotChannelStatusCheckLock,
  releaseBotChannelStatusCheck,
  tryReserveBotChannelStatusCheck,
  upsertLoginIdentity,
  upsertBotIdentity,
  upsertBotIdentityAndStatus,
} from "../../src/worker/auth/repository";
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

describe("Auth-D1-Repository", () => {
  it("legt eine nachvollziehbare Session an und liest sie zurück", async () => {
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

  it("verbraucht eine OAuth-Transaktion nur einmal anhand des gespeicherten Zustands", async () => {
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

  it("verbraucht keine OAuth-Transaktion mit nicht parsebarem Ablaufwert", async () => {
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

  it("hinterlegt die Ursache eines fehlgeschlagenen OAuth-Rücklaufs", async () => {
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

  it("speichert und widerruft eine Session nachvollziehbar", async () => {
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

  it("legt eine OAuth-Transaktion an", async () => {
    const database = new TestD1Database();
    try {
      await createOAuthTransaction(database as unknown as D1Database, {
        transactionId: "transaction-1",
        purpose: "bot",
        expiresAt: "2026-09-18T00:05:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
      });

      await expect(database.prepare(
        "SELECT transaction_id, purpose, expires_at, created_at, used_at FROM oauth_transactions",
      ).first()).resolves.toEqual({
        transaction_id: "transaction-1",
        purpose: "bot",
        expires_at: "2026-09-18T00:05:00.000Z",
        created_at: "2026-09-18T00:00:00.000Z",
        used_at: null,
      });
    } finally {
      database.close();
    }
  });

  it("liest die globale Bot-Identität aus der Ein-Zeilen-Tabelle", async () => {
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

  it("speichert Login-Tokens getrennt von der Session und listet sie", async () => {
    const database = new TestD1Database();
    const identity = {
      userId: "user-1",
      login: "tester",
      scopesJson: "[\"user:read:moderated_channels\"]",
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

  it("aktualisiert die Bot-Identität über id = 1", async () => {
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

  it("merkt den globalen Verbindungsstatus mit Ursache", async () => {
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

  it("liest und speichert den Moderatorstatus je Kanal", async () => {
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

  it("liefert die freigegebenen Kanal-IDs für den Moderatorabgleich", async () => {
    const { database } = fakeDatabase();

    await expect(listChannelIds(database)).resolves.toEqual(["channel-1"]);
  });

  it("räumt abgelaufene OAuth-Transaktionen auf", async () => {
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

  it("ersetzt den Bot-Access-Token nur einmal mit dem echten SQLite-CAS", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO bot_identity
          (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, created_at, updated_at)
         VALUES (1, 'bot-user', 'brobot', '[]', 'access-alt', 'refresh-alt', ?, ?, ?)`,
      ).bind(
        "2026-09-18T01:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();

      await expect(rotateBotTokens(
        database as unknown as D1Database,
        "access-alt",
        "refresh-alt",
        "access-ciphertext-neu",
        "refresh-alt",
        "2026-09-18T02:00:00.000Z",
        "2026-09-18T01:00:00.000Z",
      )).resolves.toBe(true);
      await expect(rotateBotTokens(
        database as unknown as D1Database,
        "access-alt",
        "refresh-alt",
        "access-ciphertext-second",
        "refresh-alt",
        "2026-09-18T03:00:00.000Z",
        "2026-09-18T02:00:00.000Z",
      )).resolves.toBe(false);

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

  it("ändert den Botstatus bei einer zweiten Rotation mit veraltetem Access-Ciphertext nicht", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO bot_identity
          (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, created_at, updated_at)
         VALUES (1, 'bot-user', 'brobot', '[]', 'access-alt', 'refresh-alt', ?, ?, ?)`,
      ).bind(
        "2026-09-18T01:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      await database.prepare(
        `INSERT INTO bot_identity_status (id, status, reason, updated_at)
         VALUES (1, 'revoked', 'authorization_revoked', ?)`,
      ).bind("2026-09-18T02:00:00.000Z").run();

      await expect(rotateBotTokens(
        database as unknown as D1Database,
        "access-alt",
        "refresh-alt",
        "access-ciphertext-neu",
        "refresh-ciphertext-neu",
        "2026-09-18T02:00:00.000Z",
        "2026-09-18T01:00:00.000Z",
      )).resolves.toBe(true);
      await expect(rotateBotTokens(
        database as unknown as D1Database,
        "access-alt",
        "refresh-alt",
        "access-ciphertext-second",
        "refresh-ciphertext-neu",
        "2026-09-18T03:00:00.000Z",
        "2026-09-18T03:00:00.000Z",
      )).resolves.toBe(false);

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

  it("widerruft keine aktive Session mit veraltetem Login-Access-Ciphertext", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO twitch_login_identity
          (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, status, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "user-1",
        "tester",
        "[]",
        "access-alt",
        "refresh-alt",
        "2026-09-19T00:00:00.000Z",
        "revoked",
        "authorization_revoked",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T02:00:00.000Z",
      ).run();
      await database.prepare(
        `INSERT INTO auth_sessions
          (session_id, user_id, login, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        "session-1",
        "user-1",
        "tester",
        "2026-09-19T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();

      await expect(rotateLoginTokensForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "access-ciphertext-neu",
        "refresh-alt",
        "2026-09-20T00:00:00.000Z",
        "2026-09-18T01:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      )).resolves.toBe(true);
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

  it("speichert bei einer zweiten Login-Rotation keinen neuen Access-Ciphertext", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO twitch_login_identity
          (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, status, reason, created_at, updated_at)
         VALUES ('user-1', 'tester', '[]', 'access-alt', 'refresh-alt', ?, 'connected', NULL, ?, ?)`,
      ).bind(
        "2026-09-19T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();

      await expect(rotateLoginTokensForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "access-ciphertext-neu",
        "refresh-alt",
        "2026-09-20T00:00:00.000Z",
        "2026-09-18T01:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      )).resolves.toBe(true);
      await expect(rotateLoginTokensForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "access-ciphertext-second",
        "refresh-alt",
        "2026-09-21T00:00:00.000Z",
        "2026-09-18T02:00:00.000Z",
        "2026-09-18T01:00:00.000Z",
      )).resolves.toBe(false);

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

  it("stellt keine Session mit veraltetem Login-Access-Ciphertext wieder her", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO twitch_login_identity
          (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, status, reason, created_at, updated_at)
         VALUES ('user-1', 'tester', '[]', 'access-alt', 'refresh-alt', ?, 'connected', NULL, ?, ?)`,
      ).bind(
        "2026-09-19T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      await database.prepare(
        `INSERT INTO auth_sessions
          (session_id, user_id, login, expires_at, created_at, updated_at, revoked_at, revocation_reason)
         VALUES ('session-1', 'user-1', 'tester', ?, ?, ?, ?, 'authorization_revoked')`,
      ).bind(
        "2026-09-19T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T02:00:00.000Z",
        "2026-09-18T02:00:00.000Z",
      ).run();

      await expect(rotateLoginTokensForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "access-ciphertext-neu",
        "refresh-ciphertext-neu",
        "2026-09-20T00:00:00.000Z",
        "2026-09-18T01:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      )).resolves.toBe(true);
      await expect(rotateLoginTokensForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "access-ciphertext-second",
        "refresh-ciphertext-neu",
        "2026-09-21T00:00:00.000Z",
        "2026-09-18T03:00:00.000Z",
        "2026-09-18T01:00:00.000Z",
      )).resolves.toBe(false);

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

  it("stellt nach einem verspäteten invalid_grant den erfolgreich gespeicherten Botstand wieder her", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO bot_identity
          (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, created_at, updated_at)
         VALUES (1, 'bot-user', 'brobot', '[]', 'access-alt', 'refresh-alt', ?, ?, ?)`,
      ).bind(
        "2026-09-18T01:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      await database.prepare(
        `INSERT INTO bot_identity_status (id, status, reason, updated_at)
         VALUES (1, 'connected', NULL, ?)`,
      ).bind("2026-09-18T00:00:00.000Z").run();

      await expect(setBotIdentityStatusIfCurrent(
        database as unknown as D1Database,
        "revoked",
        "authorization_revoked",
        "2026-09-18T00:00:01.000Z",
        "access-alt",
        "refresh-alt",
      )).resolves.toBe(true);
      await expect(rotateBotTokens(
        database as unknown as D1Database,
        "access-alt",
        "refresh-alt",
        "access-neu",
        "refresh-neu",
        "2026-09-18T02:00:00.000Z",
        "2026-09-18T00:00:02.000Z",
      )).resolves.toBe(true);

      await expect(database.prepare(
        "SELECT status, reason FROM bot_identity_status WHERE id = 1",
      ).first()).resolves.toEqual({ status: "connected", reason: null });
    } finally {
      database.close();
    }
  });

  it("stellt nach einem verspäteten invalid_grant den Loginstand und aktive Sessions wieder her", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO twitch_login_identity
          (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, status, reason, created_at, updated_at)
         VALUES ('user-1', 'tester', '[]', 'access-alt', 'refresh-alt', ?, 'connected', NULL, ?, ?)`,
      ).bind(
        "2026-09-18T01:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      await database.prepare(
        `INSERT INTO auth_sessions
          (session_id, user_id, login, expires_at, created_at, updated_at)
         VALUES ('session-1', 'user-1', 'tester', ?, ?, ?)`,
      ).bind(
        "2026-09-19T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();

      await expect(revokeLoginIdentityAndSessionsForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "authorization_revoked",
        "2026-09-18T00:00:01.000Z",
      )).resolves.toBe(true);
      await expect(rotateLoginTokensForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "access-neu",
        "refresh-neu",
        "2026-09-18T02:00:00.000Z",
        "2026-09-18T00:00:02.000Z",
        "2026-09-18T00:00:00.000Z",
      )).resolves.toBe(true);

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

  it("überschreibt einen frischeren Moderatorstatus nicht durch ein verspätetes Ergebnis", async () => {
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

  it("gibt eine Sperre nur mit ihrem Besitzer frei", async () => {
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

  it("führt Identität und Botstatus in einer atomaren Batch-Operation aus", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO bot_identity
          (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, created_at, updated_at)
         VALUES (1, 'bot-user', 'brobot', '[]', 'alt-access', 'alt-refresh', ?, ?, ?)`,
      ).bind(
        "2026-09-19T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      await database.prepare(
        `INSERT INTO bot_identity_status (id, status, reason, updated_at)
         VALUES (1, 'revoked', 'authorization_revoked', ?)`,
      ).bind("2026-09-18T00:00:00.000Z").run();

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
});
