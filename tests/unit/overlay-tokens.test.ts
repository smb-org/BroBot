import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authenticateOverlayToken,
  revokeOverlayToken,
} from "../../src/worker/auth/overlay-token-service";
import { hashOverlayToken } from "../../src/worker/auth/crypto";
import { getOverlayBindingForToken } from "../../src/worker/auth/overlay-token-repository";
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

let testTokenNumber = 0;

const insertUnboundToken = async (
  database: TestD1Database,
  input: { channelId: string; pepper: string; publicOrigin: string; expiresAt: string | null; createdAt: string },
): Promise<{ tokenId: string; overlayUrl: string; expiresAt: string | null }> => {
  testTokenNumber += 1;
  const tokenBytes = new Uint8Array(32).fill(testTokenNumber % 255);
  const token = btoa(String.fromCharCode(...tokenBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const tokenId = `legacy-token-${String(testTokenNumber)}`;
  await database.prepare(
    `INSERT INTO overlay_tokens (token_id, channel_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(tokenId, input.channelId, await hashOverlayToken(token, input.pepper), input.expiresAt, input.createdAt).run();
  const overlayUrl = new URL("/overlay", input.publicOrigin);
  overlayUrl.hash = new URLSearchParams({ token }).toString();
  return { tokenId, overlayUrl: overlayUrl.toString(), expiresAt: input.expiresAt };
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

const readAudits = async (database: TestD1Database) => database.prepare(
  `SELECT actor_user_id, created_at, channel_id, module_id, action, before_json, after_json
     FROM audit_log
    ORDER BY created_at, audit_id`,
).all<{
  actor_user_id: string;
  created_at: string;
  channel_id: string;
  module_id: string | null;
  action: string;
  before_json: string;
  after_json: string;
}>();

describe("Overlay token service", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertActor(database, "kanal-a");
  });

  afterEach(() => {
    database.close();
  });

  it("ties the hash to the pepper instead of recognizing the token", async () => {
    const first = await hashOverlayToken("tokenwert", pepper(4));
    const same = await hashOverlayToken("tokenwert", pepper(4));
    const otherPepper = await hashOverlayToken("tokenwert", pepper(5));

    expect(first).toBe(same);
    expect(otherPepper).not.toBe(first);
  });

  it("authenticates an existing unbound token only with the same pepper", async () => {
    const issued = await insertUnboundToken(database, {
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

  it("rejects an expired token", async () => {
    const token = "abgelaufen-token";
    await insertStoredToken(database, token, "kanal-a", "2026-09-18T00:00:00.000Z");

    await expect(authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:01:00.000Z",
    })).resolves.toBeNull();
  });

  it("rejects a token after revocation", async () => {
    const issued = await insertUnboundToken(database, {
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

  it("audits revocation without the token, and only on success", async () => {
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: "2099-09-18T12:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const token = tokenFromUrl(issued.overlayUrl);

    await expect(readAudits(database)).resolves.toMatchObject({ results: [] });

    await expect(revokeOverlayToken(database as unknown as D1Database, {
      actor: TEST_ACTOR,
      channelId: "kanal-a",
      tokenId: issued.tokenId,
      reason: "Quelle entfernt",
      revokedAt: "2026-09-18T00:01:00.000Z",
    })).resolves.toBe(true);

    await expect(readAudits(database)).resolves.toMatchObject({
      results: [{
        actor_user_id: TEST_ACTOR.userId,
        channel_id: "kanal-a",
        module_id: null,
        action: "overlay.token.revoked",
        before_json: JSON.stringify({
          tokenId: issued.tokenId,
          createdAt: "2026-09-18T00:00:00.000Z",
          expiresAt: "2099-09-18T12:00:00.000Z",
          revokedAt: null,
          revocationReason: null,
        }),
        after_json: JSON.stringify({
          tokenId: issued.tokenId,
          createdAt: "2026-09-18T00:00:00.000Z",
          expiresAt: "2099-09-18T12:00:00.000Z",
          revokedAt: "2026-09-18T00:01:00.000Z",
          revocationReason: "Quelle entfernt",
        }),
      }],
    });
    const auditText = JSON.stringify(await readAudits(database));
    expect(auditText).not.toContain(token);

    await expect(revokeOverlayToken(database as unknown as D1Database, {
      actor: TEST_ACTOR,
      channelId: "kanal-a",
      tokenId: issued.tokenId,
      reason: "Noch einmal",
      revokedAt: "2026-09-18T00:02:00.000Z",
    })).resolves.toBe(true);
    const finalAudits = await readAudits(database);
    expect(finalAudits.results).toHaveLength(1);
  });

  it("denies the operator revoking a legacy token in the mutation guard", async () => {
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = ? AND user_id = ?")
      .bind("kanal-a", TEST_ACTOR.userId).run();

    await expect(revokeOverlayToken(database as unknown as D1Database, {
      actor: TEST_ACTOR,
      channelId: "kanal-a",
      tokenId: issued.tokenId,
      reason: "Quelle entfernt",
      revokedAt: "2026-09-18T00:01:00.000Z",
    })).resolves.toBe(false);
  });

  it("rejects a token without an approved channel", async () => {
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

  it("rejects a token after its channel is deleted", async () => {
    const issued = await insertUnboundToken(database, {
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

  it("does not turn an in-flight bound request into a legacy request after overlay deletion", async () => {
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const token = tokenFromUrl(issued.overlayUrl);
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-a', 'kanal-a', 'Gameplay', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare("UPDATE overlay_tokens SET overlay_id = 'overlay-a' WHERE token_id = ?")
      .bind(issued.tokenId).run();

    const inFlight = await authenticateOverlayToken(database as unknown as D1Database, {
      token,
      pepper: pepper(4),
      now: "2026-09-18T00:00:30.000Z",
    });
    expect(inFlight).not.toBeNull();

    await database.prepare(
      `UPDATE overlay_tokens
          SET revoked_at = '2026-09-18T00:01:00.000Z', revocation_reason = 'overlay_deleted'
        WHERE token_id = ?`,
    ).bind(issued.tokenId).run();
    await database.prepare("DELETE FROM overlays WHERE channel_id = 'kanal-a' AND overlay_id = 'overlay-a'").run();

    await expect(database.prepare("SELECT overlay_id, revoked_at FROM overlay_tokens WHERE token_id = ?")
      .bind(issued.tokenId).first()).resolves.toEqual({
      overlay_id: "overlay-a",
      revoked_at: "2026-09-18T00:01:00.000Z",
    });
    await expect(getOverlayBindingForToken(database as unknown as D1Database, "kanal-a", issued.tokenId))
      .rejects.toThrow("Authenticated overlay token has been revoked.");
  });

  it("writes last_used_at at most every five minutes", async () => {
    const issued = await insertUnboundToken(database, {
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

  it("doesn't revoke a token when the session is revoked", async () => {
    const issued = await insertUnboundToken(database, {
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
