import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authenticateOverlayToken,
  issueOverlayToken,
  revokeOverlayToken,
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
    const issued = await issueOverlayToken(database as unknown as D1Database, {
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
    const issued = await issueOverlayToken(database as unknown as D1Database, {
      channelId: "kanal-a",
      pepper: pepper(4),
      publicOrigin: "https://brobot.example",
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const token = tokenFromUrl(issued.overlayUrl);

    await expect(revokeOverlayToken(database as unknown as D1Database, {
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
    const issued = await issueOverlayToken(database as unknown as D1Database, {
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
    const issued = await issueOverlayToken(database as unknown as D1Database, {
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
});
