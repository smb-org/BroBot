import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TestKeyRing {
  active: { id: string; key: string };
  retired: [];
}

const testKey = (byte: number): string => Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url");
const keyRing = (id: string, byte: number): string => JSON.stringify({
  active: { id, key: testKey(byte) },
  retired: [],
});

/** Port of the e2e wrangler worker; override with WORKER_PORT to run checks in parallel. */
export const e2eWorkerPort = process.env.WORKER_PORT ?? "8787";
export const e2eWorkerOrigin = `http://127.0.0.1:${e2eWorkerPort}`;
export const e2eWorkerPersist = process.env.E2E_WORKER_PERSIST ??
  mkdtempSync(join(tmpdir(), "brobot-e2e-worker-"));
process.env.E2E_WORKER_PERSIST = e2eWorkerPersist;
export const e2eOverlayToken = testKey(7);
export const e2eChannelId = "channel-e2e";
const e2eOverlayId = "overlay-e2e";
const e2eMigrationCount = readdirSync(new URL("../../migrations/", import.meta.url))
  .filter((fileName) => fileName.endsWith(".sql")).length;
const e2eMigrationRunLimit = e2eMigrationCount + 1;
const e2eMigrationOutputLimit = Math.max(8 * 1024 * 1024, e2eMigrationCount ** 2 * 1024);
export const e2eWorkerEnvironment: Record<string, string> = {
  TWITCH_CLIENT_ID: "e2e-twitch-client-id",
  TWITCH_CLIENT_SECRET: "e2e-twitch-client-secret",
  TWITCH_EVENTSUB_SECRET: keyRing("e2e-eventsub", 3),
  PUBLIC_ORIGIN: e2eWorkerOrigin,
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

export const seedE2EOverlay = (channelId = e2eChannelId): void => {
  const overlayId = channelId === e2eChannelId ? e2eOverlayId : `overlay-${channelId}`;
  const channelLogin = channelId === e2eChannelId ? "kanal-e2e" : `e2e-${channelId.slice(-12)}`;
  const overlayToken = channelId === e2eChannelId ? e2eOverlayToken : `${e2eOverlayToken}-${channelId}`;
  const pepper = Buffer.from(e2eWorkerEnvironment.OVERLAY_TOKEN_PEPPER ?? "", "base64url");
  const tokenHash = createHmac("sha256", pepper).update(overlayToken).digest("base64url");
  const createdAt = new Date().toISOString();
  const sql = `
    DELETE FROM channels WHERE channel_id = '${channelId}';
    DELETE FROM auth_sessions WHERE session_id = 'session-e2e';
    DELETE FROM twitch_login_identity WHERE user_id = 'user-e2e';
    INSERT INTO channels (channel_id, login, display_name, language, created_at, updated_at)
      VALUES ('${channelId}', '${channelLogin}', 'E2E Kanal', 'en', '${createdAt}', '${createdAt}');
    INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
      VALUES ('${channelId}', 'user-e2e', 'manager', '${createdAt}', '${createdAt}');
    INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, created_at, updated_at)
      VALUES ('user-e2e', 'e2e-tester', '[]', 'test-access', 'test-refresh',
        '2099-01-01T00:00:00.000Z', 'connected', '${createdAt}', '${createdAt}');
    INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at)
      VALUES ('session-e2e', 'user-e2e', 'e2e-tester', '2099-01-01T00:00:00.000Z', '${createdAt}', '${createdAt}');
    INSERT INTO overlays (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
      VALUES ('${overlayId}', '${channelId}', 'E2E Overlay', 1920, 1080, '', 1, '${createdAt}', '${createdAt}');
    INSERT INTO channel_variables (channel_id, name, value, description, reset_on_stream_start, created_at, updated_at)
      VALUES ('${channelId}', 'score', 7, '', 0, '${createdAt}', '${createdAt}');
    INSERT INTO overlay_elements
      (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json,
       x, y, scale_percent, z, in_composition)
      VALUES ('element-e2e-${channelId}', '${channelId}', '${overlayId}', 'variable', 'Score', 'score',
        'Score {value}', '{}', 0, 0, 100, 0, 1);
    INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at, revoked_at, revocation_reason,
       last_used_at, overlay_id, label, secret_envelope)
      VALUES ('token-e2e-${channelId}', '${channelId}', '${tokenHash}', NULL, '${createdAt}', NULL, NULL,
        NULL, '${overlayId}', 'Playwright E2E', NULL);
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
  const applyMigrations = (): void => {
    let lastOutput = "";
    for (let run = 1; run <= e2eMigrationRunLimit; run += 1) {
      const result = spawnSync("./node_modules/.bin/wrangler", [
        "--cwd", "dist/brobot_local", "--config", "wrangler.json", "d1", "migrations", "apply", "DB", "--local",
        "--persist-to", e2eWorkerPersist,
      ], {
        encoding: "utf8",
        maxBuffer: e2eMigrationOutputLimit,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", ...e2eWorkerEnvironment },
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.error || result.status !== 0) {
        const failure = result.error?.message ?? `Wrangler exited with status ${String(result.status)}`;
        throw new Error(`Wrangler e2e database migrations failed on run ${String(run)}/${String(e2eMigrationRunLimit)}: ${failure}.\n${output.slice(-4000)}`);
      }
      if (output.includes("No migrations to apply!")) return;
      if (!output.includes("Migrations to be applied:")) {
        throw new Error(`Wrangler e2e database migrations returned success without reporting pending or completed migrations on run ${String(run)}/${String(e2eMigrationRunLimit)}.\n${output.slice(-4000)}`);
      }
      lastOutput = output;
    }
    throw new Error(`Wrangler e2e database migrations did not report "No migrations to apply!" after ${String(e2eMigrationRunLimit)} runs for ${String(e2eMigrationCount)} migration files.\n${lastOutput.slice(-4000)}`);
  };
  applyMigrations();
  wrangler(["--cwd", "dist/brobot_local", "--config", "wrangler.json", "d1", "execute", "DB", "--local", "--yes", "--persist-to", e2eWorkerPersist, "--command", sql]);
};

export const seedE2ETestArea = (channelId = e2eChannelId): void => {
  seedE2EOverlay(channelId);
  const createdAt = new Date().toISOString();
  const sql = `
    INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
      VALUES ('${channelId}', 'text_commands', 1, '{}');
    INSERT INTO text_commands (channel_id, command_name, response_text, aliases_json, created_at, updated_at)
      VALUES ('${channelId}', 'discord', 'Discord: discord.gg/e2e', '["dc"]', '${createdAt}', '${createdAt}');
    INSERT INTO text_command_aliases (channel_id, alias, command_name)
      VALUES ('${channelId}', 'dc', 'discord');
  `;
  const result = spawnSync("./node_modules/.bin/wrangler", [
    "--cwd", "dist/brobot_local", "--config", "wrangler.json", "d1", "execute", "DB", "--local", "--yes",
    "--persist-to", e2eWorkerPersist, "--command", sql,
  ], {
    encoding: "utf8",
    env: { ...process.env, CI: "1", ...e2eWorkerEnvironment },
  });
  if (result.status !== 0) {
    throw new Error(`Wrangler test area setup failed.\n${result.stdout}\n${result.stderr}`);
  }
};

export const seedE2EStatisticsStreams = (channelId = e2eChannelId): void => {
  seedE2EOverlay(channelId);
  const streamId = "e2e-stream-574";
  const firstWindow = Math.floor((Date.now() - 15 * 60_000) / 300_000) * 300_000;
  const windowStart = (offset: number): string => new Date(firstWindow + offset).toISOString();
  const startMillis = firstWindow;
  const createdAt = new Date().toISOString();
  const sql = `
    INSERT OR REPLACE INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, created_at, updated_at)
      VALUES (1, 'bot-e2e', 'brobot-e2e', '[]', 'test-access', 'test-refresh', '2099-01-01T00:00:00.000Z', '${createdAt}', '${createdAt}');
    INSERT OR REPLACE INTO bot_identity_status (id, status, reason, updated_at)
      VALUES (1, 'connected', NULL, '${createdAt}');
    INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
      VALUES ('${channelId}', 'statistics', 1, '{}')
      ON CONFLICT(channel_id, module_id) DO UPDATE SET enabled = 1;
    INSERT INTO channel_statistics
      (channel_id, stream_id, window_start, messages, emotes, viewer_count, chatters, active_chatters)
      VALUES
      ('${channelId}', '${streamId}', '${windowStart(0)}', 84, 12, 105, 31, 24),
      ('${channelId}', '${streamId}', '${windowStart(300_000)}', 132, 25, 148, 44, 37),
      ('${channelId}', '${streamId}', '${windowStart(600_000)}', 119, 18, 181, 51, 42);
    INSERT INTO channel_timeline_events (channel_id, event_key, stream_id, occurred_at, kind, detail_json)
      VALUES
      ('${channelId}', 'e2e-statistics-online', '${streamId}', '${windowStart(0)}', 'stream_online', '{}'),
      ('${channelId}', 'e2e-statistics-meta-one', NULL, '${windowStart(60_000)}', 'channel_metadata', '{"title":"E2E Stream","category":{"id":"game-1","name":"Game One"}}'),
      ('${channelId}', 'raid_incoming:e2e-raid-in', NULL, '${windowStart(150_000)}', 'raid_incoming', '{"viewers":37,"partner":{"id":"e2e-partner-a","login":"e2e_partner_a","displayName":"E2E Partner A"}}'),
      ('${channelId}', 'raid_outgoing:e2e-raid-out', NULL, '${windowStart(300_000)}', 'raid_outgoing', '{"viewers":52,"partner":{"id":"e2e-partner-b","login":"e2e_partner_b","displayName":"E2E Partner B"}}'),
      ('${channelId}', 'e2e-statistics-clip', NULL, '${windowStart(420_000)}', 'clip_created', '{"clipId":"e2e-clip","title":"E2E highlight"}'),
      ('${channelId}', 'e2e-statistics-meta-two', NULL, '${windowStart(480_000)}', 'channel_metadata', '{"title":"E2E Stream","category":{"id":"game-2","name":"Game Two"}}'),
      ('${channelId}', 'e2e-statistics-offline', NULL, '${windowStart(540_000)}', 'stream_offline', '{}'),
      ('${channelId}', 'e2e-statistics-reconnect', '${streamId}', '${windowStart(780_000)}', 'stream_online', '{}');
    INSERT INTO belabox_bitrate_windows
      (channel_id, stream_id, window_start, bitrate_min, bitrate_max, bitrate_avg, bitrate_p10, rtt_avg, dropped_delta, sample_count)
      VALUES
      ('${channelId}', 'e2e-belabox-stream', ${String(startMillis)}, 4000, 6000, 5400, 5000, 40, 0, 6),
      ('${channelId}', 'e2e-belabox-stream', ${String(startMillis + 300_000)}, 4100, 6100, 5500, 5100, 42, 1, 6);
  `;
  const result = spawnSync("./node_modules/.bin/wrangler", [
    "--cwd", "dist/brobot_local", "--config", "wrangler.json", "d1", "execute", "DB", "--local", "--yes",
    "--persist-to", e2eWorkerPersist, "--command", sql,
  ], {
    encoding: "utf8",
    env: { ...process.env, CI: "1", ...e2eWorkerEnvironment },
  });
  if (result.status !== 0) {
    throw new Error(`Statistics streams e2e setup failed.\n${result.stdout}\n${result.stderr}`);
  }
};

export const seedE2EStatisticsWords = (channelId = e2eChannelId): void => {
  seedE2EStatisticsStreams(channelId);
  const observedAt = new Date().toISOString();
  const sql = `
    INSERT OR REPLACE INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at)
      VALUES
      ('${channelId}', 'halloween', 20, '${observedAt}'),
      ('${channelId}', 'hallway', 12, '${observedAt}'),
      ('${channelId}', 'lol', 10, '${observedAt}');
  `;
  const result = spawnSync("./node_modules/.bin/wrangler", [
    "--cwd", "dist/brobot_local", "--config", "wrangler.json", "d1", "execute", "DB", "--local", "--yes",
    "--persist-to", e2eWorkerPersist, "--command", sql,
  ], {
    encoding: "utf8",
    env: { ...process.env, CI: "1", ...e2eWorkerEnvironment },
  });
  if (result.status !== 0) {
    throw new Error(`Statistics words e2e setup failed.\n${result.stdout}\n${result.stderr}`);
  }
};
