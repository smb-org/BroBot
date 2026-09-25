import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

interface TestKeyRing {
  active: { id: string; key: string };
  retired: [];
}

const testKey = (byte: number): string => Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url");
const keyRing = (id: string, byte: number): string => JSON.stringify({
  active: { id, key: testKey(byte) },
  retired: [],
});

export const e2eOverlayToken = testKey(7);
export const e2eChannelId = "channel-e2e";
export const e2eOverlayId = "overlay-e2e";
export const e2eWorkerEnvironment: Record<string, string> = {
  TWITCH_CLIENT_ID: "e2e-twitch-client-id",
  TWITCH_CLIENT_SECRET: "e2e-twitch-client-secret",
  TWITCH_EVENTSUB_SECRET: keyRing("e2e-eventsub", 3),
  PUBLIC_ORIGIN: "http://127.0.0.1:8787",
  SESSION_COOKIE_KEYS: keyRing("e2e-cookie", 1),
  TOKEN_ENCRYPTION_KEYS: keyRing("e2e-encryption", 2),
  OVERLAY_TOKEN_PEPPER: testKey(4),
  PLATFORM_USER_IDS: "[]",
};

const encodeJson = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const activeKey = (serialized: string): TestKeyRing["active"] =>
  (JSON.parse(serialized) as TestKeyRing).active;

const signJson = (value: unknown, serializedKeyRing: string): string => {
  const key = activeKey(serializedKeyRing);
  const payload = encodeJson({ keyId: key.id, payload: encodeJson(value) });
  const signature = createHmac("sha256", Buffer.from(key.key, "base64url"))
    .update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

const encryptJson = (value: unknown, serializedKeyRing: string): string => {
  const key = activeKey(serializedKeyRing);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key.key, "base64url"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return encodeJson({ keyId: key.id, iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url") });
};

export const createE2ESessionCredentials = (): { cookie: string; csrfToken: string } => {
  const sessionId = "session-e2e";
  const encryptedSession = encryptJson(
    { sessionId },
    e2eWorkerEnvironment.TOKEN_ENCRYPTION_KEYS ?? "",
  );
  const cookie = signJson(encryptedSession, e2eWorkerEnvironment.SESSION_COOKIE_KEYS ?? "");
  const csrfToken = signJson({
    sessionId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }, e2eWorkerEnvironment.SESSION_COOKIE_KEYS ?? "");
  return { cookie, csrfToken };
};

export const seedE2EOverlay = (): void => {
  const pepper = Buffer.from(e2eWorkerEnvironment.OVERLAY_TOKEN_PEPPER ?? "", "base64url");
  const tokenHash = createHmac("sha256", pepper).update(e2eOverlayToken).digest("base64url");
  const createdAt = new Date().toISOString();
  const sql = `
    DELETE FROM channels WHERE channel_id = '${e2eChannelId}';
    DELETE FROM auth_sessions WHERE session_id = 'session-e2e';
    DELETE FROM twitch_login_identity WHERE user_id = 'user-e2e';
    INSERT INTO channels (channel_id, login, display_name, language, created_at, updated_at)
      VALUES ('${e2eChannelId}', 'kanal-e2e', 'E2E Kanal', 'en', '${createdAt}', '${createdAt}');
    INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
      VALUES ('${e2eChannelId}', 'user-e2e', 'manager', '${createdAt}', '${createdAt}');
    INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, created_at, updated_at)
      VALUES ('user-e2e', 'e2e-tester', '[]', 'test-access', 'test-refresh',
        '2099-01-01T00:00:00.000Z', 'connected', '${createdAt}', '${createdAt}');
    INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at)
      VALUES ('session-e2e', 'user-e2e', 'e2e-tester', '2099-01-01T00:00:00.000Z', '${createdAt}', '${createdAt}');
    INSERT INTO overlays (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
      VALUES ('${e2eOverlayId}', '${e2eChannelId}', 'E2E Overlay', 1920, 1080, '', 1, '${createdAt}', '${createdAt}');
    INSERT INTO channel_variables (channel_id, name, value, description, reset_on_stream_start, created_at, updated_at)
      VALUES ('${e2eChannelId}', 'score', 7, '', 0, '${createdAt}', '${createdAt}');
    INSERT INTO overlay_elements
      (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json,
       x, y, scale_percent, z, in_composition)
      VALUES ('element-e2e', '${e2eChannelId}', '${e2eOverlayId}', 'variable', 'Score', 'score',
        'Score {value}', '{}', 0, 0, 100, 0, 1);
    INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at, revoked_at, revocation_reason,
       last_used_at, overlay_id, label, secret_envelope)
      VALUES ('token-e2e', '${e2eChannelId}', '${tokenHash}', NULL, '${createdAt}', NULL, NULL,
        NULL, '${e2eOverlayId}', 'Playwright E2E', NULL);
  `;
  const wrangler = (arguments_: string[]): void => {
    const result = spawnSync("./node_modules/.bin/wrangler", arguments_, {
      encoding: "utf8",
      env: { ...process.env, CI: "1", ...e2eWorkerEnvironment },
    });
    if (result.status !== 0) {
      throw new Error(`Wrangler e2e database setup failed.\n${result.stdout}\n${result.stderr}`);
    }
  };
  wrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", ".wrangler/e2e-worker"]);
  wrangler(["d1", "execute", "DB", "--local", "--yes", "--persist-to", ".wrangler/e2e-worker", "--command", sql]);
};
