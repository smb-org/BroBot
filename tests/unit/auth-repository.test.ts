import { describe, expect, it, vi } from "vitest";

import {
  consumeOAuthTransaction,
  actorGuard,
  betreiberSessionGuard,
  createChannelMemberWithAudit,
  createSession,
  createOAuthTransaction,
  deleteChannelMemberWithAudit,
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
  updateChannelMemberWithAudit,
  upsertLoginIdentity,
  upsertBotIdentity,
  upsertBotIdentityAndStatus,
} from "../../src/worker/auth/repository";
import type { ActorContext, ChannelMemberRecord } from "../../src/worker/auth/repository";
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

const frischerZeitpunkt = (): string => new Date().toISOString();

const zeitpunktMitAbstand = (zeitpunkt: string, abstandMs: number): string =>
  new Date(Date.parse(zeitpunkt) + abstandMs).toISOString();

// Test-Fixtures: säen den Rohzustand direkt per SQL, weil die Rotations- und
// CAS-Tests genau die Zeilen prüfen, die eine echte Vorbedingung erzeugen —
// nicht das, was die Repository-Funktionen selbst schreiben würden. Nur
// Belanglosigkeiten (User-/Login-Namen, leere Scopes) stecken als Vorgabe im
// Helfer; Status, Ciphertexte und Zeitstempel kommen an jeder Aufrufstelle
// explizit mit, weil sie den jeweiligen Test ausmachen.

interface BotIdentitaetFixture {
  userId: string;
  login: string;
  scopesJson: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

const saeeBotIdentitaet = async (
  database: TestD1Database,
  overrides: Partial<BotIdentitaetFixture> = {},
): Promise<void> => {
  const identitaet: BotIdentitaetFixture = {
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
    identitaet.userId,
    identitaet.login,
    identitaet.scopesJson,
    identitaet.accessTokenCiphertext,
    identitaet.refreshTokenCiphertext,
    identitaet.expiresAt,
    identitaet.createdAt,
    identitaet.updatedAt,
  ).run();
};

const saeeBotIdentitaetsstatus = async (
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

interface LoginIdentitaetFixture {
  userId: string;
  login: string;
  scopesJson: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  status: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

const saeeLoginIdentitaet = async (
  database: TestD1Database,
  overrides: Partial<LoginIdentitaetFixture> = {},
): Promise<void> => {
  const identitaet: LoginIdentitaetFixture = {
    userId: "user-1",
    login: "tester",
    scopesJson: "[]",
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
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    identitaet.userId,
    identitaet.login,
    identitaet.scopesJson,
    identitaet.accessTokenCiphertext,
    identitaet.refreshTokenCiphertext,
    identitaet.expiresAt,
    identitaet.status,
    identitaet.reason,
    identitaet.createdAt,
    identitaet.updatedAt,
  ).run();
};

interface SitzungFixture {
  sessionId: string;
  userId: string;
  login: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
}

const saeeSitzung = async (
  database: TestD1Database,
  overrides: Partial<SitzungFixture> = {},
): Promise<void> => {
  const sitzung: SitzungFixture = {
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
    sitzung.sessionId,
    sitzung.userId,
    sitzung.login,
    sitzung.expiresAt,
    sitzung.createdAt,
    sitzung.updatedAt,
    sitzung.revokedAt,
    sitzung.revocationReason,
  ).run();
};

const saeeKanal = async (database: TestD1Database, channelId: string): Promise<void> => {
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

const saeeKanalmitglied = async (
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

const mitgliedFuer = (
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

interface GuardAkteurFixture {
  actor: ActorContext;
  channelId: string;
  role: ChannelMemberRecord["role"];
  identityStatus?: string;
  sessionExpiresAt: string;
  revokedAt?: string | null;
}

const saeeGuardAkteur = async (
  database: TestD1Database,
  fixture: GuardAkteurFixture,
): Promise<void> => {
  await saeeKanal(database, fixture.channelId);
  await saeeLoginIdentitaet(database, {
    userId: fixture.actor.userId,
    login: fixture.actor.userId,
    status: fixture.identityStatus ?? "connected",
  });
  await saeeSitzung(database, {
    sessionId: fixture.actor.sessionId,
    userId: fixture.actor.userId,
    login: fixture.actor.userId,
    expiresAt: fixture.sessionExpiresAt,
    revokedAt: fixture.revokedAt ?? null,
  });
  await saeeKanalmitglied(database, {
    channelId: fixture.channelId,
    userId: fixture.actor.userId,
    role: fixture.role,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  });
};

const leseKanalmitglied = async (
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
 * Gemeinsamer Ablauf aller actorGuard-Verweigerungstests: Datenbank anlegen,
 * Ausgangszustand säen, eine mutierende Repository-Funktion unter einem
 * Akteur aufrufen, die Ablehnung prüfen und den unveränderten Endzustand
 * nachweisen. Die eine Angriffsvariante, die den jeweiligen Test ausmacht —
 * Rolle, Kanal, Zeitstempel, Ziel-Endzustand — steckt vollständig in `aufbau`,
 * `mutation` und `pruefeEndzustand` an der jeweiligen Aufrufstelle.
 */
const erwarteAbgelehnteGuardMutation = async (
  aufbau: (database: TestD1Database, jetzt: string) => Promise<void>,
  mutation: (database: D1Database, jetzt: string) => Promise<boolean>,
  pruefeEndzustand: (database: TestD1Database) => Promise<void>,
): Promise<void> => {
  const database = new TestD1Database();
  const jetzt = frischerZeitpunkt();
  try {
    await aufbau(database, jetzt);
    await expect(mutation(database as unknown as D1Database, jetzt)).resolves.toBe(false);
    await pruefeEndzustand(database);
  } finally {
    database.close();
  }
};

// Schmale Wrapper um die Rotationsaufrufe: benannte Felder statt langer
// Positionsargumentlisten, damit an der Aufrufstelle erkennbar bleibt, welcher
// Wert der erwartete (CAS-)Ist-Zustand und welcher der neue Soll-Zustand ist.

interface RotiereBotTokensFelder {
  expectedAccessTokenCiphertext: string;
  expectedRefreshTokenCiphertext: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  updatedAt: string;
}

const rotiereBotTokens = (
  database: D1Database,
  felder: RotiereBotTokensFelder,
): Promise<boolean> => rotateBotTokens(
  database,
  felder.expectedAccessTokenCiphertext,
  felder.expectedRefreshTokenCiphertext,
  felder.accessTokenCiphertext,
  felder.refreshTokenCiphertext,
  felder.expiresAt,
  felder.updatedAt,
);

interface RotiereLoginTokensFelder {
  userId: string;
  expectedAccessTokenCiphertext: string;
  expectedRefreshTokenCiphertext: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  updatedAt: string;
  expectedUpdatedAt: string;
}

const rotiereLoginTokens = (
  database: D1Database,
  felder: RotiereLoginTokensFelder,
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
      await saeeBotIdentitaet(database);

      await expect(rotiereBotTokens(database as unknown as D1Database, {
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-alt",
        expiresAt: "2026-09-18T02:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
      })).resolves.toBe(true);
      await expect(rotiereBotTokens(database as unknown as D1Database, {
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

  it("ändert den Botstatus bei einer zweiten Rotation mit veraltetem Access-Ciphertext nicht", async () => {
    const database = new TestD1Database();
    try {
      await saeeBotIdentitaet(database);
      await saeeBotIdentitaetsstatus(database, "revoked", "authorization_revoked", "2026-09-18T02:00:00.000Z");

      await expect(rotiereBotTokens(database as unknown as D1Database, {
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-ciphertext-neu",
        expiresAt: "2026-09-18T02:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
      })).resolves.toBe(true);
      await expect(rotiereBotTokens(database as unknown as D1Database, {
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

  it("widerruft keine aktive Session mit veraltetem Login-Access-Ciphertext", async () => {
    const database = new TestD1Database();
    try {
      await saeeLoginIdentitaet(database, {
        status: "revoked",
        reason: "authorization_revoked",
        updatedAt: "2026-09-18T02:00:00.000Z",
      });
      await saeeSitzung(database);

      await expect(rotiereLoginTokens(database as unknown as D1Database, {
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

  it("speichert bei einer zweiten Login-Rotation keinen neuen Access-Ciphertext", async () => {
    const database = new TestD1Database();
    try {
      await saeeLoginIdentitaet(database);

      await expect(rotiereLoginTokens(database as unknown as D1Database, {
        userId: "user-1",
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-alt",
        expiresAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
        expectedUpdatedAt: "2026-09-18T00:00:00.000Z",
      })).resolves.toBe(true);
      await expect(rotiereLoginTokens(database as unknown as D1Database, {
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

  it("stellt keine Session mit veraltetem Login-Access-Ciphertext wieder her", async () => {
    const database = new TestD1Database();
    try {
      await saeeLoginIdentitaet(database);
      await saeeSitzung(database, {
        updatedAt: "2026-09-18T02:00:00.000Z",
        revokedAt: "2026-09-18T02:00:00.000Z",
        revocationReason: "authorization_revoked",
      });

      await expect(rotiereLoginTokens(database as unknown as D1Database, {
        userId: "user-1",
        expectedAccessTokenCiphertext: "access-alt",
        expectedRefreshTokenCiphertext: "refresh-alt",
        accessTokenCiphertext: "access-ciphertext-neu",
        refreshTokenCiphertext: "refresh-ciphertext-neu",
        expiresAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-18T01:00:00.000Z",
        expectedUpdatedAt: "2026-09-18T00:00:00.000Z",
      })).resolves.toBe(true);
      await expect(rotiereLoginTokens(database as unknown as D1Database, {
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

  it("stellt nach einem verspäteten invalid_grant den erfolgreich gespeicherten Botstand wieder her", async () => {
    const database = new TestD1Database();
    try {
      await saeeBotIdentitaet(database);
      await saeeBotIdentitaetsstatus(database, "connected", null, "2026-09-18T00:00:00.000Z");

      await expect(setBotIdentityStatusIfCurrent(
        database as unknown as D1Database,
        "revoked",
        "authorization_revoked",
        "2026-09-18T00:00:01.000Z",
        "access-alt",
        "refresh-alt",
      )).resolves.toBe(true);
      await expect(rotiereBotTokens(database as unknown as D1Database, {
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

  it("stellt nach einem verspäteten invalid_grant den Loginstand und aktive Sessions wieder her", async () => {
    const database = new TestD1Database();
    try {
      await saeeLoginIdentitaet(database, { expiresAt: "2026-09-18T01:00:00.000Z" });
      await saeeSitzung(database);

      await expect(revokeLoginIdentityAndSessionsForUser(
        database as unknown as D1Database,
        "user-1",
        "access-alt",
        "refresh-alt",
        "authorization_revoked",
        "2026-09-18T00:00:01.000Z",
      )).resolves.toBe(true);
      await expect(rotiereLoginTokens(database as unknown as D1Database, {
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
      await saeeBotIdentitaet(database, {
        accessTokenCiphertext: "alt-access",
        refreshTokenCiphertext: "alt-refresh",
        expiresAt: "2026-09-19T00:00:00.000Z",
      });
      await saeeBotIdentitaetsstatus(database, "revoked", "authorization_revoked", "2026-09-18T00:00:00.000Z");

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

  it("verweigert INSERT, wenn die Session einem anderen Nutzer als dem Actor gehört", () =>
    erwarteAbgelehnteGuardMutation(
      (database, jetzt) => saeeGuardAkteur(database, {
        actor: { userId: "user-b", sessionId: "session-b" },
        channelId: "kanal-a",
        role: "broadcaster",
        sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
      }),
      (database, jetzt) => createChannelMemberWithAudit(
        database,
        { userId: "user-a", sessionId: "session-b" },
        mitgliedFuer("kanal-a", "target-user", "bediener"),
        "mitglied.hinzugefügt",
        jetzt,
        actorGuard("'broadcaster', 'verwalter'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toBeNull();
      },
    ));

  it("verweigert INSERT mit einer widerrufenen Session", () =>
    erwarteAbgelehnteGuardMutation(
      (database, jetzt) => saeeGuardAkteur(database, {
        actor: { userId: "user-1", sessionId: "session-1" },
        channelId: "kanal-a",
        role: "broadcaster",
        sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
        revokedAt: zeitpunktMitAbstand(jetzt, -1_000),
      }),
      (database, jetzt) => createChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        mitgliedFuer("kanal-a", "target-user", "bediener"),
        "mitglied.hinzugefügt",
        jetzt,
        actorGuard("'broadcaster', 'verwalter'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toBeNull();
      },
    ));

  it("verweigert UPDATE mit einer widerrufenen Session", () =>
    erwarteAbgelehnteGuardMutation(
      async (database, jetzt) => {
        await saeeGuardAkteur(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "verwalter",
          sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
          revokedAt: zeitpunktMitAbstand(jetzt, -1_000),
        });
        await saeeKanalmitglied(database, mitgliedFuer("kanal-a", "target-user", "bediener"));
      },
      (database, jetzt) => updateChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        { ...mitgliedFuer("kanal-a", "target-user", "verwalter"), updatedAt: jetzt },
        "mitglied.rolle_geändert",
        jetzt,
        actorGuard("'broadcaster', 'verwalter'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "bediener" });
      },
    ));

  it("verweigert DELETE mit einer widerrufenen Session", () =>
    erwarteAbgelehnteGuardMutation(
      async (database, jetzt) => {
        await saeeGuardAkteur(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "verwalter",
          sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
          revokedAt: zeitpunktMitAbstand(jetzt, -1_000),
        });
        await saeeKanalmitglied(database, mitgliedFuer("kanal-a", "target-user", "bediener"));
      },
      (database, jetzt) => deleteChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        "kanal-a",
        "target-user",
        "mitglied.entfernt",
        jetzt,
        actorGuard("'broadcaster', 'verwalter'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "bediener" });
      },
    ));

  it("verweigert UPDATE mit einer abgelaufenen Session", () =>
    erwarteAbgelehnteGuardMutation(
      async (database, jetzt) => {
        await saeeGuardAkteur(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "verwalter",
          sessionExpiresAt: zeitpunktMitAbstand(jetzt, -1_000),
        });
        await saeeKanalmitglied(database, mitgliedFuer("kanal-a", "target-user", "bediener"));
      },
      (database, jetzt) => updateChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        { ...mitgliedFuer("kanal-a", "target-user", "verwalter"), updatedAt: jetzt },
        "mitglied.rolle_geändert",
        jetzt,
        actorGuard("'broadcaster', 'verwalter'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "bediener" });
      },
    ));

  it("verweigert DELETE für eine widerrufene Twitch-Identität", () =>
    erwarteAbgelehnteGuardMutation(
      async (database, jetzt) => {
        await saeeGuardAkteur(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "verwalter",
          identityStatus: "revoked",
          sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
        });
        await saeeKanalmitglied(database, mitgliedFuer("kanal-a", "target-user", "bediener"));
      },
      (database, jetzt) => deleteChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        "kanal-a",
        "target-user",
        "mitglied.entfernt",
        jetzt,
        actorGuard("'broadcaster', 'verwalter'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "bediener" });
      },
    ));

  it("verweigert INSERT in einem anderen Kanal als dem des Actors", () =>
    erwarteAbgelehnteGuardMutation(
      async (database, jetzt) => {
        await saeeGuardAkteur(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "broadcaster",
          sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
        });
        await saeeKanal(database, "kanal-b");
      },
      (database, jetzt) => createChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        mitgliedFuer("kanal-b", "target-user", "bediener"),
        "mitglied.hinzugefügt",
        jetzt,
        actorGuard("'broadcaster', 'verwalter'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-b", "target-user")).resolves.toBeNull();
      },
    ));

  it("verweigert INSERT für eine Rollenvergabe durch einen Verwalter", () =>
    erwarteAbgelehnteGuardMutation(
      (database, jetzt) => saeeGuardAkteur(database, {
        actor: { userId: "user-1", sessionId: "session-1" },
        channelId: "kanal-a",
        role: "verwalter",
        sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
      }),
      (database, jetzt) => createChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        mitgliedFuer("kanal-a", "target-user", "broadcaster"),
        "mitglied.hinzugefügt",
        jetzt,
        actorGuard("'broadcaster'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toBeNull();
      },
    ));

  it("verweigert UPDATE auf Broadcaster-Rolle durch einen Verwalter", () =>
    erwarteAbgelehnteGuardMutation(
      async (database, jetzt) => {
        await saeeGuardAkteur(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "verwalter",
          sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
        });
        await saeeKanalmitglied(database, mitgliedFuer("kanal-a", "target-user", "bediener"));
      },
      (database, jetzt) => updateChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        { ...mitgliedFuer("kanal-a", "target-user", "broadcaster"), updatedAt: jetzt },
        "mitglied.rolle_geändert",
        jetzt,
        actorGuard("'broadcaster'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "bediener" });
      },
    ));

  it("verweigert DELETE durch ein Mitglied ohne Verwalterrolle", () =>
    erwarteAbgelehnteGuardMutation(
      async (database, jetzt) => {
        await saeeGuardAkteur(database, {
          actor: { userId: "user-1", sessionId: "session-1" },
          channelId: "kanal-a",
          role: "bediener",
          sessionExpiresAt: zeitpunktMitAbstand(jetzt, 60_000),
        });
        await saeeKanalmitglied(database, mitgliedFuer("kanal-a", "target-user", "bediener"));
      },
      (database, jetzt) => deleteChannelMemberWithAudit(
        database,
        { userId: "user-1", sessionId: "session-1" },
        "kanal-a",
        "target-user",
        "mitglied.entfernt",
        jetzt,
        actorGuard("'broadcaster', 'verwalter'"),
      ),
      async (database) => {
        await expect(leseKanalmitglied(database, "kanal-a", "target-user")).resolves.toMatchObject({ role: "bediener" });
      },
    ));

  it("schreibt den Betreiber als Akteur in das Audit", async () => {
    const database = new TestD1Database();
    const jetzt = frischerZeitpunkt();
    try {
      await saeeKanal(database, "kanal-a");
      await saeeLoginIdentitaet(database, { userId: "user-1", login: "betreiber" });
      await saeeSitzung(database, {
        userId: "user-1",
        login: "betreiber",
        expiresAt: zeitpunktMitAbstand(jetzt, 60_000),
      });

      const actor = { userId: "user-1", sessionId: "session-1" };
      const changed = await createChannelMemberWithAudit(
        database as unknown as D1Database,
        actor,
        mitgliedFuer("kanal-a", "target-user", "verwalter"),
        "betreiber.mitglied.hinzugefügt",
        jetzt,
        betreiberSessionGuard(actor, jetzt),
        "betreiber",
      );

      expect(changed).toBe(true);
      await expect(database.prepare(
        "SELECT actor_kind FROM audit_log WHERE action = ?",
      ).bind("betreiber.mitglied.hinzugefügt").first()).resolves.toEqual({ actor_kind: "betreiber" });
    } finally {
      database.close();
    }
  });
});
