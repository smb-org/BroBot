import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { authRouter } from "../../src/worker/auth/routes";
import { createSessionCookie } from "../../src/worker/auth/session";
import { decryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { issueOverlayToken } from "../../src/worker/auth/overlay-token-service";
import { overlayAccessRouter } from "../../src/worker/panel/overlay-access-routes";
import { overlayRouter } from "../../src/worker/panel/overlay-routes";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const tokenKeys = JSON.stringify({ active: { id: "token-v1", key: key(2) }, retired: [] });

type TestEnvironment = Env & { DB: D1Database };

const makeEnvironment = (database: TestD1Database): TestEnvironment => ({
  DB: database as unknown as D1Database,
  CF_VERSION_METADATA: { id: "version-test", tag: "test", timestamp: "2026-09-24T00:00:00.000Z" },
  PUBLIC_ORIGIN: "https://brobot.example",
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: tokenKeys,
  TOKEN_ENCRYPTION_KEYS: tokenKeys,
  TWITCH_CLIENT_ID: "test-client-id",
  OVERLAY_TOKEN_PEPPER: key(4),
} as TestEnvironment);

const insertChannelSessionAndMember = async (database: TestD1Database, role = "manager"): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
  ).run();
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, reason, created_at, updated_at)
     VALUES ('user-1', 'tester', '[]', 'access', 'refresh', '2099-09-19T00:00:00.000Z',
       'connected', NULL, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
  ).run();
  await database.prepare(
    `INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at)
     VALUES ('session-1', 'user-1', 'tester', '2099-09-19T00:00:00.000Z',
       '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
  ).run();
  await database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES ('channel-a', 'user-1', ?, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
  ).bind(role).run();
  await database.prepare(
    `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
     VALUES ('overlay-a', 'channel-a', 'Gameplay', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
  ).run();
};

const sessionHeaders = async (environment: TestEnvironment): Promise<Headers> => {
  const cookie = await createSessionCookie(
    { sessionId: "session-1" },
    environment.SESSION_COOKIE_KEYS,
    environment.SESSION_ENCRYPTION_KEYS ?? "",
  );
  const csrf = await createCsrfToken("session-1", environment.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Headers({
    Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
  });
};

const accessesPath = "https://brobot.example/api/channels/channel-a/overlays/overlay-a/accesses";
const accessPath = (tokenId: string, action: "reveal" | "replace" | "revoke"): string =>
  `${accessesPath}/${tokenId}/${action}`;

const post = async (
  router: typeof overlayAccessRouter,
  path: string,
  environment: TestEnvironment,
  body?: unknown,
): Promise<Response> => router.fetch(new Request(path, {
  method: "POST",
  headers: await sessionHeaders(environment),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), environment);

const issueAccess = async (environment: TestEnvironment, label = "OBS") => {
  const response = await post(overlayAccessRouter, accessesPath, environment, { label });
  if (response.status !== 201) throw new Error(`Overlay access issuance failed with ${String(response.status)}.`);
  return response.json<{ tokenId: string; overlayUrl: string; label: string; expiresAt: string | null }>();
};

const tokenFromUrl = (overlayUrl: string): string => {
  const token = new URLSearchParams(new URL(overlayUrl).hash.slice(1)).get("token");
  if (token === null) throw new Error("Issued URL did not contain an overlay token.");
  return token;
};

describe("overlay access routes", () => {
  let database: TestD1Database;
  let environment: TestEnvironment;

  beforeEach(async () => {
    database = new TestD1Database();
    environment = makeEnvironment(database);
    await insertChannelSessionAndMember(database);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    database.close();
  });

  it("encrypts new secrets, re-shows them, and keeps audit rows and console output secret-free", async () => {
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
    ];
    const issued = await issueAccess(environment);
    const secret = tokenFromUrl(issued.overlayUrl);
    const row = await database.prepare(
      "SELECT token_id, channel_id, token_hash, secret_envelope FROM overlay_tokens WHERE token_id = ?",
    ).bind(issued.tokenId).first<{
      token_id: string;
      channel_id: string;
      token_hash: string;
      secret_envelope: string;
    }>();
    const envelope = await decryptJson<{ v: number; tokenId: string; channelId: string; token: string }>(
      row?.secret_envelope ?? "",
      parseKeyRing(tokenKeys),
    );

    expect(row?.channel_id).toBe("channel-a");
    expect(envelope).toEqual({ v: 1, tokenId: issued.tokenId, channelId: "channel-a", token: secret });
    expect(row?.token_hash).not.toBe(secret);
    expect(row?.secret_envelope).not.toContain(secret);

    const reveal = await post(overlayAccessRouter, accessPath(issued.tokenId, "reveal"), environment);
    expect(reveal.status).toBe(200);
    await expect(reveal.json()).resolves.toEqual({ overlayUrl: issued.overlayUrl });
    expect(reveal.headers.get("Cache-Control")).toBe("no-store");

    const audits = await database.prepare(
      "SELECT action, before_json, after_json FROM audit_log ORDER BY created_at, audit_id",
    ).all<{ action: string; before_json: string | null; after_json: string | null }>();
    expect(audits.results.map((audit) => audit.action)).toEqual([
      "overlay.access.issued", "overlay.access.revealed",
    ]);
    expect(JSON.stringify(audits.results)).not.toContain(secret);
    expect(JSON.stringify(audits.results)).not.toContain(row?.secret_envelope);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls).flat().join(" ")).not.toContain(secret);
  });

  it("rejects an encrypted envelope copied to another access row", async () => {
    const first = await issueAccess(environment, "OBS main");
    const second = await issueAccess(environment, "OBS backup");
    const envelope = await database.prepare("SELECT secret_envelope FROM overlay_tokens WHERE token_id = ?")
      .bind(first.tokenId).first<{ secret_envelope: string }>();
    await database.prepare("UPDATE overlay_tokens SET secret_envelope = ? WHERE token_id = ?")
      .bind(envelope?.secret_envelope ?? null, second.tokenId).run();

    const reveal = await post(overlayAccessRouter, accessPath(second.tokenId, "reveal"), environment);
    expect(reveal.status).toBe(409);
    await expect(reveal.json()).resolves.toEqual({ error: "overlay_access_unrecoverable" });
  });

  it("keeps legacy channel tokens usable and reports them as unrecoverable on re-show", async () => {
    const legacy = await issueOverlayToken(database as unknown as D1Database, {
      channelId: "channel-a",
      actor: { userId: "user-1", sessionId: "session-1" },
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    });
    expect(legacy).not.toBeNull();
    const token = tokenFromUrl(legacy?.overlayUrl ?? "");
    const status = await authRouter.fetch(new Request("https://brobot.example/api/overlay/status", {
      headers: { Authorization: `Bearer ${token}` },
    }), environment);
    expect(status.status).toBe(200);

    const reveal = await authRouter.fetch(new Request(
      `https://brobot.example/api/channels/channel-a/overlay-tokens/${legacy?.tokenId ?? ""}/reveal`,
      { method: "POST", headers: await sessionHeaders(environment) },
    ), environment);
    expect(reveal.status).toBe(409);
    await expect(reveal.json()).resolves.toEqual({ error: "overlay_access_unrecoverable" });
  });

  it("keeps the old access active when replacing it", async () => {
    const oldAccess = await issueAccess(environment, "OBS main");
    const replacement = await post(overlayAccessRouter, accessPath(oldAccess.tokenId, "replace"), environment);
    const newAccess = await replacement.json<{
      tokenId: string;
      label: string;
      overlayUrl: string;
      expiresAt: string | null;
      replacesTokenId: string;
    }>();

    expect(replacement.status).toBe(201);
    expect(newAccess.tokenId).not.toBe(oldAccess.tokenId);
    expect(newAccess.label).toBe("OBS main 2");
    expect(newAccess.expiresAt).toBeNull();
    expect(newAccess.replacesTokenId).toBe(oldAccess.tokenId);
    expect(await database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?")
      .bind(oldAccess.tokenId).first()).toEqual({ revoked_at: null });
    expect(tokenFromUrl(newAccess.overlayUrl)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("replaces an expired access with a requested fresh expiry and a distinct label within 40 characters", async () => {
    const oldAccess = await issueAccess(environment, "X".repeat(40));
    await database.prepare("UPDATE overlay_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token_id = ?")
      .bind(oldAccess.tokenId).run();

    const replacement = await post(overlayAccessRouter, accessPath(oldAccess.tokenId, "replace"), environment, {
      expiresAt: "2099-09-18T12:00:00.000Z",
    });
    const newAccess = await replacement.json<{ label: string; expiresAt: string | null }>();

    expect(replacement.status).toBe(201);
    expect(newAccess.label).toBe(`${"X".repeat(38)} 2`);
    expect(newAccess.label).not.toBe("X".repeat(40));
    expect(newAccess.label).toHaveLength(40);
    expect(newAccess.expiresAt).toBe("2099-09-18T12:00:00.000Z");
  });

  it("lets operators read access metadata but rejects issuing, revealing, replacing, and revoking", async () => {
    const access = await issueAccess(environment);
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'channel-a'").run();

    const list = await overlayAccessRouter.fetch(new Request(accessesPath, {
      headers: await sessionHeaders(environment),
    }), environment);
    const responses = await Promise.all([
      post(overlayAccessRouter, accessesPath, environment, { label: "Operator attempt" }),
      post(overlayAccessRouter, accessPath(access.tokenId, "reveal"), environment),
      post(overlayAccessRouter, accessPath(access.tokenId, "replace"), environment),
      post(overlayAccessRouter, accessPath(access.tokenId, "revoke"), environment),
    ]);
    expect([list.status, ...responses.map((response) => response.status)]).toEqual([200, 403, 403, 403, 403]);
    const listed = await list.json<{ accesses: Record<string, unknown>[] }>();
    expect(listed.accesses).toHaveLength(1);
    expect(listed.accesses[0]).toMatchObject({ tokenId: access.tokenId, label: access.label });
    expect(listed.accesses[0]).not.toHaveProperty("overlayUrl");
    expect(listed.accesses[0]).not.toHaveProperty("secretEnvelope");
    expect(await database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?")
      .bind(access.tokenId).first()).toEqual({ revoked_at: null });
  });

  it("closes live sockets after an access is revoked", async () => {
    const access = await issueAccess(environment);
    const close = vi.fn().mockResolvedValue(true);
    environment.CHANNEL = {
      idFromName: vi.fn(() => "channel-object"),
      get: vi.fn(() => ({ revokeToken: close })),
    } as unknown as Env["CHANNEL"];

    const response = await post(overlayAccessRouter, accessPath(access.tokenId, "revoke"), environment);
    expect(response.status).toBe(204);
    expect(close).toHaveBeenCalledWith(access.tokenId);
    const row = await database.prepare("SELECT revoked_at, revocation_reason FROM overlay_tokens WHERE token_id = ?")
      .bind(access.tokenId).first<{ revoked_at: string | null; revocation_reason: string | null }>();
    expect(row?.revoked_at).toBeTruthy();
    expect(row?.revocation_reason).toBe("manual");
  });

  it("revokes overlay accesses and closes their sockets when the overlay is deleted", async () => {
    const access = await issueAccess(environment);
    const close = vi.fn().mockResolvedValue(true);
    environment.CHANNEL = {
      idFromName: vi.fn(() => "channel-object"),
      get: vi.fn(() => ({ revokeToken: close })),
    } as unknown as Env["CHANNEL"];

    const response = await overlayRouter.fetch(new Request(
      "https://brobot.example/api/channels/channel-a/overlays/overlay-a",
      {
        method: "DELETE",
        headers: await sessionHeaders(environment),
        body: JSON.stringify({ baseRevision: 1 }),
      },
    ), environment);

    expect(response.status).toBe(204);
    expect(close).toHaveBeenCalledWith(access.tokenId);
    expect(await database.prepare("SELECT overlay_id, revoked_at, revocation_reason FROM overlay_tokens WHERE token_id = ?")
      .bind(access.tokenId).first()).toMatchObject({
      overlay_id: "overlay-a",
      revocation_reason: "overlay_deleted",
    });
    expect((await database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?")
      .bind(access.tokenId).first<{ revoked_at: string | null }>())?.revoked_at).toBeTruthy();
    expect(await database.prepare("SELECT action FROM audit_log WHERE action = 'overlay.access.revoked'").all())
      .toMatchObject({ results: [{ action: "overlay.access.revoked" }] });
  });
});
