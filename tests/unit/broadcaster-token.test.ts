import { describe, expect, it, vi } from "vitest";

import type { HelixResult } from "../../src/modules/contract";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { getLoginIdentity, upsertLoginIdentity } from "../../src/worker/db/login-identity";
import { withBroadcasterToken } from "../../src/worker/auth/broadcaster-token";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "1000001";
const NOW = "2026-10-23T10:00:00.000Z";
const KEY_RING = JSON.stringify({
  active: { id: "test-key", key: Buffer.from(new Uint8Array(32).fill(9)).toString("base64url") },
  retired: [],
});
const SUCCESS: HelixResult<{ value: string }> = { ok: true, status: 200, data: { value: "done" } };
const UNAUTHORIZED: HelixResult<{ value: string }> = {
  ok: false,
  status: 401,
  reason: "http_401",
  message: "Invalid OAuth token",
  body: {},
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "test-client",
  TWITCH_CLIENT_SECRET: "test-secret",
  TOKEN_ENCRYPTION_KEYS: KEY_RING,
  CHANNEL: {
    idFromName: (name: string) => name,
    get: () => ({ revokeUser: () => Promise.resolve() }),
  } as unknown as Env["CHANNEL"],
} as unknown as Env);

const encryptedToken = async (token: string): Promise<string> =>
  encryptJson({ token }, parseKeyRing(KEY_RING));

const seedIdentity = async (
  database: TestD1Database,
  options: { expiresAt?: string; status?: "connected" | "revoked"; scopes?: string[] } = {},
): Promise<void> => {
  await upsertLoginIdentity(database as unknown as D1Database, {
    userId: CHANNEL_ID,
    login: "test-channel",
    scopesJson: JSON.stringify(options.scopes ?? ["channel:manage:broadcast"]),
    tokenScopesJson: JSON.stringify(options.scopes ?? ["channel:manage:broadcast"]),
    accessTokenCiphertext: await encryptedToken("old-access-token"),
    refreshTokenCiphertext: await encryptedToken("old-refresh-token"),
    expiresAt: options.expiresAt ?? "2099-10-23T10:00:00.000Z",
    status: options.status ?? "connected",
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
};

const refreshedTokenResponse = (scopes = ["channel:manage:broadcast"]): Response => new Response(JSON.stringify({
  access_token: "new-access-token",
  refresh_token: "new-refresh-token",
  expires_in: 7_200,
  scope: scopes,
}), { status: 200, headers: { "Content-Type": "application/json" } });

describe("withBroadcasterToken", () => {
  it("uses a connected broadcaster token without requiring an active session", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const call = vi.fn((token: string) => {
        expect(token).toBe("old-access-token");
        return Promise.resolve(SUCCESS);
      });

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher: vi.fn<typeof fetch>() },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });
      expect(call).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("refreshes a token that expires within the proactive window before calling Helix", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { expiresAt: "2026-10-23T10:04:00.000Z" });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(refreshedTokenResponse());
      const call = vi.fn((token: string) => Promise.resolve(token === "new-access-token" ? SUCCESS : UNAUTHORIZED));

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });

      expect(fetcher).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledOnce();
      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({
        expiresAt: "2026-10-23T12:00:00.000Z",
        tokenScopesJson: '["channel:manage:broadcast"]',
      });
    } finally {
      database.close();
    }
  });

  it("refreshes once after a 401 and retries with the replacement access token", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(refreshedTokenResponse());
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>()
        .mockResolvedValueOnce(UNAUTHORIZED)
        .mockResolvedValueOnce(SUCCESS);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });

      expect(call.mock.calls.map(([token]) => token)).toEqual(["old-access-token", "new-access-token"]);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("does not refresh again when the retry also returns 401", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(refreshedTokenResponse());
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>().mockResolvedValue(UNAUTHORIZED);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "http_error", result: UNAUTHORIZED });

      expect(call).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("revokes the identity and clears scopes when refresh returns invalid_grant", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ));
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>().mockResolvedValue(UNAUTHORIZED);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "revoked", source: "refresh" });

      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({
        status: "revoked",
        reason: "authorization_revoked",
        scopesJson: "[]",
        tokenScopesJson: "[]",
      });
      expect(call).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("leaves identity state unchanged when refresh fails for a non-revocation reason", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const before = await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
        JSON.stringify({ error: "invalid_client" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ));
      const call = vi.fn().mockResolvedValue(UNAUTHORIZED);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "refresh_failed" });

      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toEqual(before);
      expect(call).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("returns missing scopes without calling the network", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { scopes: ["moderation:read"] });
      const fetcher = vi.fn<typeof fetch>();
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>();

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "scope_missing", missing: ["channel:manage:broadcast"] });

      expect(call).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("reports a previously revoked identity without calling the network", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { status: "revoked" });
      const fetcher = vi.fn<typeof fetch>();
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>();

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "revoked", source: "stored" });

      expect(call).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("uses a concurrently stored replacement token after a stale refresh gets invalid_grant", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        await upsertLoginIdentity(database as unknown as D1Database, {
          userId: CHANNEL_ID,
          login: "test-channel",
          scopesJson: '["channel:manage:broadcast"]',
          tokenScopesJson: '["channel:manage:broadcast"]',
          accessTokenCiphertext: await encryptedToken("concurrent-access-token"),
          refreshTokenCiphertext: await encryptedToken("concurrent-refresh-token"),
          expiresAt: "2026-10-23T12:00:00.000Z",
          status: "connected",
          reason: null,
          createdAt: NOW,
          updatedAt: NOW,
        });
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      });
      const call = vi.fn((token: string) => Promise.resolve(token === "concurrent-access-token" ? SUCCESS : UNAUTHORIZED));

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });

      expect(call.mock.calls.map(([token]) => token)).toEqual(["old-access-token", "concurrent-access-token"]);
      expect((await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID))?.status).toBe("connected");
    } finally {
      database.close();
    }
  });
});
