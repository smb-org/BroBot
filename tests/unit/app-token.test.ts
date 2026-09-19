import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAppAccessToken, shouldRefreshAppAccessToken } from "../../src/worker/app-token";
import { decryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { TestD1Database } from "./test-d1";

const encryptionKeys = JSON.stringify({
  active: {
    id: "encryption-v1",
    key: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
  },
  retired: [],
});

describe("App-Access-Token", () => {
  let database: TestD1Database;
  const environment = () => ({
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: encryptionKeys,
  } as unknown as Env);

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
  });

  it("holt den App-Token über Client-Credentials und speichert ihn verschlüsselt", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "app-access", expires_in: 7200, token_type: "bearer" }),
      { status: 200 },
    ));

    await expect(getAppAccessToken(
      environment(),
      "2026-09-19T10:00:00.000Z",
      fetcher,
    )).resolves.toBe("app-access");
    expect(fetcher).toHaveBeenCalledWith(
      "https://id.twitch.tv/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    const row = await database.prepare(
      "SELECT access_token_ciphertext, expires_at FROM twitch_app_access_token WHERE id = 1",
    ).first<{ access_token_ciphertext: string; expires_at: string }>();
    expect(row).not.toBeNull();
    if (row === null) throw new Error("App-Token fehlt");
    expect(row.access_token_ciphertext).not.toContain("app-access");
    await expect(decryptJson<{ token: string }>(
      row.access_token_ciphertext,
      parseKeyRing(encryptionKeys),
    )).resolves.toEqual({ token: "app-access" });
  });

  it("verwendet den Cache und erneuert erst im Vorlauf vor Ablauf", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "first", expires_in: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "second", expires_in: 7200 }), { status: 200 }));
    const env = environment();

    await expect(getAppAccessToken(env, "2026-09-19T10:00:00.000Z", fetcher)).resolves.toBe("first");
    await expect(getAppAccessToken(env, "2026-09-19T10:30:00.000Z", fetcher)).resolves.toBe("first");
    await expect(getAppAccessToken(env, "2026-09-19T11:01:00.000Z", fetcher)).resolves.toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("behandelt unbekannte oder abgelaufene Zeitwerte als erneuerungsbedürftig", () => {
    expect(shouldRefreshAppAccessToken("kein-datum", "2026-09-19T10:00:00.000Z")).toBe(true);
    expect(shouldRefreshAppAccessToken("2026-09-19T11:00:01.000Z", "2026-09-19T10:00:00.000Z")).toBe(false);
    expect(shouldRefreshAppAccessToken("2026-09-19T11:00:00.000Z", "2026-09-19T10:00:00.000Z")).toBe(true);
  });
});
