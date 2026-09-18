import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authenticateOverlayToken,
  issueOverlayToken,
  revokeOverlayToken,
  type IssueOverlayTokenInput,
  type IssuedOverlayToken,
} from "../../src/worker/auth/overlay-token-service";
import { hashOverlayToken } from "../../src/worker/auth/crypto";
import { TestD1Database } from "./test-d1";

const pepper = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const insertChannel = async (database: TestD1Database, channelId: string): Promise<void> => {
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

/** Der Akteur, unter dem die Tests Token ausgeben; passt zu insertActor. */
const TEST_ACTOR = { userId: "user-1", sessionId: "session-user-1" };

const insertActor = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, '[]', 'access', 'refresh', ?, 'connected', NULL, ?, ?)`,
  ).bind(TEST_ACTOR.userId, TEST_ACTOR.userId, "2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
  await database.prepare(
    `INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    TEST_ACTOR.sessionId,
    TEST_ACTOR.userId,
    TEST_ACTOR.userId,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
  await database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, 'broadcaster', ?, ?)`,
  ).bind(channelId, TEST_ACTOR.userId, "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

/** Gibt ein Token aus und schlaegt fehl, wenn die Ausgabe verweigert wurde. */
const issueTestToken = async (
  database: TestD1Database,
  input: Omit<IssueOverlayTokenInput, "actor">,
): Promise<IssuedOverlayToken> => {
  const issued = await issueOverlayToken(
    database as unknown as D1Database,
    { ...input, actor: TEST_ACTOR },
  );
  if (issued === null) throw new Error("Overlay-Token wurde unerwartet nicht ausgegeben.");
  return issued;
};

const tokenFromUrl = (overlayUrl: string): string => {
  const token = new URLSearchParams(new URL(overlayUrl).hash.slice(1)).get("token");
  if (token === null) throw new Error("Ausgabe-URL enthält kein Overlay-Token.");
  return token;
};

const insertStoredToken = async (
  database: TestD1Database,
  token: string,
  channelId: string,
  expiresAt: string | null,
): Promise<string> => {
  const tokenId = `token-${token}`;
  await database.prepare(
    `INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    tokenId,
    channelId,
    await hashOverlayToken(token, pepper(4)),
    expiresAt,
    "2026-09-18T00:00:00.000Z",
  ).run();
  return tokenId;
};

describe("Overlay-Token-Service", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertActor(database, "kanal-a");
  });

  afterEach(() => {
    database.close();
  });

  it("bindet den Hash an den Pepper statt den Token wiederzuerkennen", async () => {
    const first = await hashOverlayToken("tokenwert", pepper(4));
    const same = await hashOverlayToken("tokenwert", pepper(4));
    const otherPepper = await hashOverlayToken("tokenwert", pepper(5));

    expect(first).toBe(same);
    expect(otherPepper).not.toBe(first);
  });

  it("gibt einen langen Token ohne Ablauf aus und akzeptiert ihn nur mit demselben Pepper", async () => {
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const token = tokenFromUrl(issued.overlayUrl);

    expect(token).toHaveLength(43);
    expect(new URL(issued.overlayUrl).search).toBe("");
    await expect(authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2099-09-18T00:00:00.000Z",
    })).resolves.toMatchObject({ channelId: "kanal-a", expiresAt: null });
    await expect(authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(5),
      now: "2099-09-18T00:00:00.000Z",
    })).resolves.toBeNull();
  });

  it("weist einen abgelaufenen Token ab", async () => {
    const token = "abgelaufen-token";
    await insertStoredToken(database, token, "kanal-a", "2026-09-18T00:00:00.000Z");

    await expect(authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:01:00.000Z",
    })).resolves.toBeNull();
  });

  it("weist einen Token nach dem Widerruf ab", async () => {
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const token = tokenFromUrl(issued.overlayUrl);

    await expect(revokeOverlayToken(database as unknown as D1Database, {
      actor: TEST_ACTOR,
      channelId: "kanal-a",
      tokenId: issued.tokenId,
      reason: "Quelle entfernt",
      revokedAt: "2026-09-18T00:01:00.000Z",
    })).resolves.toBe(true);
    await expect(authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:02:00.000Z",
    })).resolves.toBeNull();
  });

  it("weist einen Token ohne freigegebenen Kanal ab", async () => {
    const token = "nicht-freigegeben-token";
    database.sqlite.exec("PRAGMA foreign_keys = OFF");
    await insertStoredToken(database, token, "nicht-freigegeben", null);
    database.sqlite.exec("PRAGMA foreign_keys = ON");

    await expect(authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:01:00.000Z",
    })).resolves.toBeNull();
  });

  it("weist einen Token nach dem Löschen seines Kanals ab", async () => {
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const token = tokenFromUrl(issued.overlayUrl);
    await database.prepare("DELETE FROM channels WHERE channel_id = ?").bind("kanal-a").run();

    await expect(authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:01:00.000Z",
    })).resolves.toBeNull();
  });

  it("schreibt last_used_at höchstens alle fünf Minuten", async () => {
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const token = tokenFromUrl(issued.overlayUrl);

    const first = await authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:00:00.000Z",
    });
    const second = await authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:01:00.000Z",
    });
    const third = await authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:06:00.000Z",
    });

    expect(first?.lastUsedAt).toBe("2026-09-18T00:00:00.000Z");
    expect(second?.lastUsedAt).toBe(first?.lastUsedAt);
    expect(third?.lastUsedAt).toBe("2026-09-18T00:06:00.000Z");
  });

  it("gibt kein Token aus, wenn die Mitgliedschaft zwischen Guard und Mutation entzogen wird", async () => {
    // Zwischen dem Guard und der Ausgabe liegt request.text(). Ein Client kann
    // den Body offen lassen, bis ihm der Zugriff entzogen wurde. Nachgestellt
    // wurde eine Ausgabe nach entzogener Mitgliedschaft — Token unbefristet.
    await database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .bind("kanal-a", TEST_ACTOR.userId).run();

    await expect(issueOverlayToken(database as unknown as D1Database, {
      channelId: "kanal-a",
      actor: TEST_ACTOR,
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    })).resolves.toBeNull();

    await expect(database.prepare("SELECT COUNT(*) AS count FROM overlay_tokens")
      .first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });

  it("gibt kein Token aus, wenn die Session widerrufen ist", async () => {
    await database.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ?")
      .bind("2026-09-18T00:30:00.000Z", TEST_ACTOR.sessionId).run();

    await expect(issueOverlayToken(database as unknown as D1Database, {
      channelId: "kanal-a",
      actor: TEST_ACTOR,
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    })).resolves.toBeNull();

    await expect(database.prepare("SELECT COUNT(*) AS count FROM overlay_tokens")
      .first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });

  it("widerruft kein Token, wenn die Session widerrufen ist", async () => {
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ?")
      .bind("2026-09-18T00:30:00.000Z", TEST_ACTOR.sessionId).run();

    await expect(revokeOverlayToken(database as unknown as D1Database, {
      actor: TEST_ACTOR,
      channelId: "kanal-a",
      tokenId: issued.tokenId,
      reason: "Test",
      revokedAt: "2026-09-18T01:00:00.000Z",
    })).resolves.toBe(false);

    await expect(database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?")
      .bind(issued.tokenId).first()).resolves.toEqual({ revoked_at: null });
  });
});
