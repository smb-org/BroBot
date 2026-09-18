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
  purgeExpiredOAuthTransactions,
  rotateBotTokens,
  setBotChannelStatus,
  setBotIdentityStatus,
  upsertLoginIdentity,
  upsertBotIdentity,
} from "../../src/worker/auth/repository";
import { TestD1Database } from "./test-d1";

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
});
