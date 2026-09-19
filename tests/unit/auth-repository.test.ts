import { describe, expect, it, vi } from "vitest";

import {
  consumeOAuthTransaction,
  createSession,
  createOAuthTransaction,
  failOAuthTransaction,
  getBotIdentity,
  getAppAccessToken,
  getLoginIdentity,
  getBotIdentityStatus,
  getSession,
  listLoginIdentities,
  listChannelIds,
  revokeSession,
  revokeLoginIdentityAndSessionsForUser,
  purgeExpiredOAuthTransactions,
  rotateAppAccessToken,
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

const statefulOAuthDatabase = () => {
  let row: {
    transaction_id: string;
    purpose: "login" | "bot";
    expires_at: string;
    created_at: string;
    used_at: string | null;
  } | null = null;
  const database = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        run() {
          if (sql.includes("INSERT INTO oauth_transactions")) {
            const [transactionId, purpose, expiresAt, createdAt] = values;
            row = {
              transaction_id: String(transactionId),
              purpose: purpose as "login" | "bot",
              expires_at: String(expiresAt),
              created_at: String(createdAt),
              used_at: null,
            };
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        },
        first<T>() {
          if (row === null) return Promise.resolve(null as T | null);
          const [consumedAt, transactionId, now] = values;
          if (sql.includes("UPDATE oauth_transactions") &&
              row.transaction_id === transactionId &&
              row.used_at === null &&
              row.expires_at > String(now)) {
            row.used_at = String(consumedAt);
            return Promise.resolve({
              transaction_id: row.transaction_id,
              purpose: row.purpose,
              expires_at: row.expires_at,
              created_at: row.created_at,
            } as T);
          }
          return Promise.resolve(null as T | null);
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return { database: database as unknown as D1Database, read: () => row };
};

const statefulBotTokenDatabase = () => {
  let row = {
    updated_at: "2026-09-18T00:00:00.000Z",
    access_token_ciphertext: "access-alt",
    refresh_token_ciphertext: "refresh-alt",
    expires_at: "2026-09-18T01:00:00.000Z",
  };
  const database = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        run() {
          if (!sql.includes("UPDATE bot_identity")) return Promise.resolve({ success: true, meta: { changes: 0 } });
          const access = String(values[0]);
          const refresh = String(values[1]);
          const expiresAt = String(values[2]);
          const updatedAt = String(values[3]);
          const expectedAccess = String(values[4]);
          const expectedRefresh = String(values[5]);
          if (row.access_token_ciphertext !== expectedAccess ||
              row.refresh_token_ciphertext !== expectedRefresh) {
            return Promise.resolve({ success: true, meta: { changes: 0 } });
          }
          row = {
            updated_at: updatedAt,
            access_token_ciphertext: access,
            refresh_token_ciphertext: refresh,
            expires_at: expiresAt,
          };
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return { database: database as unknown as D1Database, read: () => row };
};

describe("Auth-D1-Repository", () => {
  it("legt eine nachvollziehbare Session an und liest sie zurück", async () => {
    const { database, statement } = fakeDatabase({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2026-09-19T00:00:00.000Z",
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
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

    await createSession(database, record);
    const session = await getSession(database, "session-1");

    expect(session).toEqual(record);
    expect(statement.bind).toHaveBeenCalledWith(
      "session-1",
      "user-1",
      "tester",
      "2026-09-19T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
  });

  it("verbraucht eine OAuth-Transaktion nur einmal anhand des gespeicherten Zustands", async () => {
    const { database, read } = statefulOAuthDatabase();
    await createOAuthTransaction(database, {
      transactionId: "transaction-1",
      purpose: "login",
      expiresAt: "2026-09-18T00:05:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await expect(consumeOAuthTransaction(database, "transaction-1", "2026-09-18T00:01:00.000Z"))
      .resolves.toEqual({
        transactionId: "transaction-1",
        purpose: "login",
        expiresAt: "2026-09-18T00:05:00.000Z",
        createdAt: "2026-09-18T00:00:00.000Z",
      });
    await expect(consumeOAuthTransaction(database, "transaction-1", "2026-09-18T00:01:01.000Z"))
      .resolves.toBeNull();
    expect(read()?.used_at).toBe("2026-09-18T00:01:00.000Z");
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
    const { database, statement } = fakeDatabase();

    await failOAuthTransaction(database, "transaction-1", "code_exchange_rejected");

    expect(statement.bind).toHaveBeenCalledWith("code_exchange_rejected", "transaction-1");
  });

  it("speichert und widerruft eine Session nachvollziehbar", async () => {
    const { database, statement } = fakeDatabase();

    await revokeSession(database, "session-1", "2026-09-18T01:00:00.000Z", "logout");

    expect(statement.bind).toHaveBeenCalledWith(
      "2026-09-18T01:00:00.000Z",
      "logout",
      "2026-09-18T01:00:00.000Z",
      "session-1",
    );
  });

  it("legt eine OAuth-Transaktion an", async () => {
    const { database, statement } = fakeDatabase();

    await createOAuthTransaction(database, {
      transactionId: "transaction-1",
      purpose: "bot",
      expiresAt: "2026-09-18T00:05:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
    });

    expect(statement.bind).toHaveBeenCalledWith(
      "transaction-1",
      "bot",
      "2026-09-18T00:05:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
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
    const { database, statement } = fakeDatabase({
      user_id: "user-1",
      login: "tester",
      scopes_json: "[\"user:read:moderated_channels\"]",
      access_token_ciphertext: "access-ciphertext",
      refresh_token_ciphertext: "refresh-ciphertext",
      expires_at: "2026-09-18T02:00:00.000Z",
      status: "connected",
      reason: null,
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
    }, { results: [{
      user_id: "user-1",
      login: "tester",
      scopes_json: "[\"user:read:moderated_channels\"]",
      access_token_ciphertext: "access-ciphertext",
      refresh_token_ciphertext: "refresh-ciphertext",
      expires_at: "2026-09-18T02:00:00.000Z",
      status: "connected",
      reason: null,
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
    }] });
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

    await upsertLoginIdentity(database, identity);
    await expect(getLoginIdentity(database, "user-1")).resolves.toEqual(identity);
    await expect(listLoginIdentities(database)).resolves.toEqual([identity]);
    expect(statement.bind).toHaveBeenCalledWith(
      "user-1",
      "tester",
      "[\"user:read:moderated_channels\"]",
      "access-ciphertext",
      "refresh-ciphertext",
      "2026-09-18T02:00:00.000Z",
      "connected",
      null,
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
  });

  it("aktualisiert die Bot-Identität über id = 1", async () => {
    const { database, statement } = fakeDatabase();

    await upsertBotIdentity(database, {
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

    expect(statement.bind).toHaveBeenCalledWith(
      1,
      "bot-user",
      "brobot",
      "[\"user:bot\"]",
      "access-ciphertext",
      "refresh-ciphertext",
      "2026-09-18T02:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
  });

  it("merkt den globalen Verbindungsstatus mit Ursache", async () => {
    const { database, statement } = fakeDatabase();

    await setBotIdentityStatus(database, "revoked", "invalid_grant", "2026-09-18T03:00:00.000Z");

    expect(statement.bind).toHaveBeenCalledWith(
      1,
      "revoked",
      "invalid_grant",
      "2026-09-18T03:00:00.000Z",
    );
  });

  it("liest und speichert den Moderatorstatus je Kanal", async () => {
    const { database, statement } = fakeDatabase({
      id: 1,
      status: "connected",
      reason: null,
      updated_at: "2026-09-18T03:00:00.000Z",
    });

    await expect(getBotIdentityStatus(database)).resolves.toEqual({
      status: "connected",
      reason: null,
      updatedAt: "2026-09-18T03:00:00.000Z",
    });
    await setBotChannelStatus(database, "channel-1", true, "2026-09-18T03:00:00.000Z", null);
    expect(statement.bind).toHaveBeenCalledWith(
      "channel-1",
      1,
      "2026-09-18T03:00:00.000Z",
      null,
    );
  });

  it("liefert die freigegebenen Kanal-IDs für den Moderatorabgleich", async () => {
    const { database } = fakeDatabase();

    await expect(listChannelIds(database)).resolves.toEqual(["channel-1"]);
  });

  it("legt den globalen App-Token per CAS nur einmal an", async () => {
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

  it("aktualisiert den App-Token nur mit dem erwarteten Ciphertext", async () => {
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

  it("räumt abgelaufene OAuth-Transaktionen auf", async () => {
    const { database, statement } = fakeDatabase();

    await purgeExpiredOAuthTransactions(database, "2026-09-18T01:00:00.000Z");

    expect(statement.bind).toHaveBeenCalledWith(
      "2026-09-18T01:00:00.000Z",
      "2026-09-18T01:00:00.000Z",
    );
  });

  it("ersetzt Access- und Refresh-Token gemeinsam und gewinnt nur einmal per CAS", async () => {
    const { database, read } = statefulBotTokenDatabase();

    await expect(rotateBotTokens(
      database,
      "access-alt",
      "refresh-alt",
      "access-ciphertext-neu",
      "refresh-ciphertext-neu",
      "2026-09-18T02:00:00.000Z",
      "2026-09-18T01:00:00.000Z",
    )).resolves.toBe(true);
    await expect(rotateBotTokens(
      database,
      "access-alt",
      "refresh-alt",
      "access-ciphertext-second",
      "refresh-ciphertext-second",
      "2026-09-18T03:00:00.000Z",
      "2026-09-18T02:00:00.000Z",
    )).resolves.toBe(false);
    expect(read()).toEqual({
      updated_at: "2026-09-18T01:00:00.000Z",
      access_token_ciphertext: "access-ciphertext-neu",
      refresh_token_ciphertext: "refresh-ciphertext-neu",
      expires_at: "2026-09-18T02:00:00.000Z",
    });
  });

  it("verwirft eine Rotation nicht wegen eines reinen Status-Updates", async () => {
    const { database, read } = statefulBotTokenDatabase();
    read().updated_at = "2026-09-18T00:00:01.000Z";

    await expect(rotateBotTokens(
      database,
      "access-alt",
      "refresh-alt",
      "access-ciphertext-neu",
      "refresh-ciphertext-neu",
      "2026-09-18T02:00:00.000Z",
      "2026-09-18T01:00:00.000Z",
    )).resolves.toBe(true);
    expect(read().access_token_ciphertext).toBe("access-ciphertext-neu");
    expect(read().refresh_token_ciphertext).toBe("refresh-ciphertext-neu");
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
