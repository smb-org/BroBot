import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { BELABOX_POLL_ALARM_KEY, BELABOX_STATS_URL_SECRET } from "../../src/modules/belabox/contracts";
import { handleBelaboxPollAlarm } from "../../src/modules/belabox/service";
import { panelRouter } from "../../src/worker/panel/routes";
import { BELABOX_DEFAULT_SETTINGS } from "../../src/modules/belabox/contracts";
import { createModuleSecretAccess } from "../../src/worker/module-secrets";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "belabox-settings-channel";
const MANAGER_ID = "belabox-settings-manager";
const SESSION_COOKIE_KEYS = JSON.stringify({ active: { id: "cookie", key: testKey(71) }, retired: [] });
const TOKEN_ENCRYPTION_KEYS = JSON.stringify({ active: { id: "token", key: testKey(72) }, retired: [] });
const UPDATED_SETTINGS = {
  ...BELABOX_DEFAULT_SETTINGS,
  mode: "on_demand" as const,
  intervalSeconds: 30 as const,
  holdSeconds: 30,
  recoverHoldSeconds: 30,
};

const requestFor = async (body: unknown, path = "/settings"): Promise<Request> => {
  const sessionId = `session-${MANAGER_ID}`;
  const cookie = await createSessionCookie({ sessionId }, SESSION_COOKIE_KEYS, TOKEN_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example/api/channels/${CHANNEL_ID}/modules/belabox${path}`, {
    method: "PATCH",
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
};

describe("BELABOX settings route", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLoginIdentityAndSession(database, MANAGER_ID);
    await insertMember(database, CHANNEL_ID, MANAGER_ID, "manager");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({ mode: "interval", intervalSeconds: 15 })).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

  const statsUrlSecrets = () => createModuleSecretAccess({
    DB: database as unknown as D1Database,
    TOKEN_ENCRYPTION_KEYS,
  }, CHANNEL_ID, "belabox");

  const writeStatsUrl = async (url: string): Promise<void> => {
    const statement = await statsUrlSecrets().prepareWrite(
      BELABOX_STATS_URL_SECRET,
      url,
      { userId: MANAGER_ID },
      "2026-10-16T10:00:00.000Z",
    );
    await statement.run();
  };

  it("saves the stats URL and settings in one revision-checked patch", async () => {
    const url = "http://relay.belabox.net:8080/publisher-key";
    const response = await panelRouter.fetch(await requestFor({
      revision: 1,
      settings: UPDATED_SETTINGS,
      statsUrl: url,
    }), {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: { idFromName: (channelId: string) => channelId, get: () => ({ runModuleAlarm: vi.fn(() => Promise.resolve()) }) },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ revision: 2, settings: UPDATED_SETTINGS });
    await expect(statsUrlSecrets().read(BELABOX_STATS_URL_SECRET)).resolves.toBe(url);
    await expect(database.prepare(
      "SELECT revision, settings_revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ revision: 2, settings_revision: 2 });
  });

  it("coordinates URL replacement and removal with sample reset and polling ensure", async () => {
    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ runModuleAlarm }),
      },
    } as unknown as Env;

    const replacement = await panelRouter.fetch(await requestFor({
      revision: 1,
      settings: BELABOX_DEFAULT_SETTINGS,
      statsUrl: "http://relay.belabox.net:8080/replacement-key",
    }), environment);
    expect(replacement.status).toBe(200);
    await expect(replacement.json()).resolves.toMatchObject({ revision: 2 });
    expect(runModuleAlarm).toHaveBeenNthCalledWith(1, "belabox", BELABOX_POLL_ALARM_KEY, BELABOX_POLL_ALARM_KEY, {
      reason: "configuration_changed",
    });
    expect(runModuleAlarm).toHaveBeenNthCalledWith(2, "belabox", "ensure", BELABOX_POLL_ALARM_KEY);

    const removal = await panelRouter.fetch(await requestFor({ revision: 2, removeStatsUrl: true }), environment);
    expect(removal.status).toBe(200);
    await expect(removal.json()).resolves.toMatchObject({ revision: 3 });
    await expect(statsUrlSecrets().read(BELABOX_STATS_URL_SECRET)).resolves.toBeNull();
    expect(runModuleAlarm).toHaveBeenNthCalledWith(3, "belabox", BELABOX_POLL_ALARM_KEY, BELABOX_POLL_ALARM_KEY, {
      reason: "configuration_changed",
    });
    expect(runModuleAlarm).toHaveBeenNthCalledWith(4, "belabox", "ensure", BELABOX_POLL_ALARM_KEY);
  });

  it("writes nothing when a stats URL and settings patch has a stale revision", async () => {
    await writeStatsUrl("http://relay.belabox.net:8080/original-key");
    await database.prepare(
      "UPDATE channel_modules SET settings_revision = 2, revision = 2 WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).run();
    const beforeModule = await database.prepare(
      "SELECT settings, revision, settings_revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first();
    const beforeSecret = await database.prepare(
      "SELECT ciphertext, revision FROM module_secrets WHERE channel_id = ? AND module_id = 'belabox' AND name = ?",
    ).bind(CHANNEL_ID, BELABOX_STATS_URL_SECRET).first();
    const beforeAudit = await database.prepare(
      "SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first<{ count: number }>();

    const response = await panelRouter.fetch(await requestFor({
      revision: 1,
      settings: UPDATED_SETTINGS,
      statsUrl: "http://relay.belabox.net:8080/replacement-key",
    }), {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: { idFromName: (channelId: string) => channelId, get: () => ({ runModuleAlarm: vi.fn(() => Promise.resolve()) }) },
    });

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT settings, revision, settings_revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual(beforeModule);
    await expect(database.prepare(
      "SELECT ciphertext, revision FROM module_secrets WHERE channel_id = ? AND module_id = 'belabox' AND name = ?",
    ).bind(CHANNEL_ID, BELABOX_STATS_URL_SECRET).first()).resolves.toEqual(beforeSecret);
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual(beforeAudit);
  });

  it("does not let a delayed settings save recreate a URL after confirmed removal", async () => {
    const originalUrl = "http://relay.belabox.net:8080/original-key";
    await writeStatsUrl(originalUrl);
    const environment = {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: { idFromName: (channelId: string) => channelId, get: () => ({ runModuleAlarm: vi.fn(() => Promise.resolve()) }) },
    } as unknown as Env;

    const removal = await panelRouter.fetch(await requestFor({ revision: 1, removeStatsUrl: true }), environment);
    expect(removal.status).toBe(200);
    await expect(statsUrlSecrets().read(BELABOX_STATS_URL_SECRET)).resolves.toBeNull();

    const delayedSave = await panelRouter.fetch(await requestFor({
      revision: 1,
      settings: UPDATED_SETTINGS,
      statsUrl: "http://relay.belabox.net:8080/replacement-key",
    }), environment);

    expect(delayedSave.status).toBe(409);
    await expect(statsUrlSecrets().read(BELABOX_STATS_URL_SECRET)).resolves.toBeNull();
    await expect(database.prepare(
      "SELECT revision, settings_revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ revision: 2, settings_revision: 2 });
  });

  it("runs the declared poll alarm immediately after a successful settings save", async () => {
    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ runModuleAlarm }),
      },
    } as unknown as Env;

    const response = await panelRouter.fetch(await requestFor({
      revision: 1,
      settings: UPDATED_SETTINGS,
    }), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settings: { mode: "on_demand", intervalSeconds: 30 },
      revision: 2,
    });
    expect(runModuleAlarm).toHaveBeenCalledOnce();
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "ensure", "poll");
  });

  it("returns success after committing settings when poll ensure fails", async () => {
    const runModuleAlarm = vi.fn(() => Promise.reject(new Error("storage details must stay hidden")));
    const environment = {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ runModuleAlarm }),
      },
    } as unknown as Env;

    const response = await panelRouter.fetch(await requestFor({
      revision: 1,
      settings: UPDATED_SETTINGS,
    }), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ revision: 2 });
    await expect(database.prepare(
      "SELECT settings, revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({
      settings: JSON.stringify(UPDATED_SETTINGS),
      revision: 2,
    });
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "ensure", "poll");
    const diagnostics = await database.prepare(
      "SELECT code FROM event_log WHERE channel_id = ? ORDER BY rowid",
    ).bind(CHANNEL_ID).all<{ code: string }>();
    expect(diagnostics.results).toEqual([{ code: "belabox.polling_ensure_failed" }]);
  });

  it("ensures the poll alarm when the module is disabled", async () => {
    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ runModuleAlarm }),
      },
    } as unknown as Env;

    const response = await panelRouter.fetch(await requestFor({ enabled: false }, ""), environment);

    expect(response.status).toBe(200);
    expect(runModuleAlarm).toHaveBeenCalledOnce();
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "ensure", "poll");
    await expect(database.prepare(
      "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ enabled: 0 });
  });

  it("finalizes the open stream in the poll alarm after BELABOX is disabled", async () => {
    const streamId = "belabox-disabled-online-stream";
    const startedAt = "2026-10-07T09:00:00.000Z";
    const sample = {
      at: "2026-10-07T09:10:00.000Z",
      connected: true,
      bitrateKbps: 3_200,
      rttMs: 41,
      latencyMs: 115,
      network: 2,
      droppedPackets: 10,
    };
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, ?, ?, 1, 3_200)`,
    ).bind(CHANNEL_ID, streamId, startedAt).run();
    await database.prepare(
      `INSERT INTO belabox_minutes
        (channel_id, minute_at, stream_id, samples, connected_samples, bitrate_min, bitrate_max,
         bitrate_sum, rtt_max, rtt_sum, dropped_delta)
       VALUES (?, '2026-10-07T09:10:00.000Z', ?, 1, 1, 3_200, 3_200, 3_200, 41, 41, 0)`,
    ).bind(CHANNEL_ID, streamId).run();
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, sampled_at, sample_json, history_sample_json, polling, stream_id,
         belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, ?, ?, ?, 1, ?, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, sample.at, JSON.stringify(sample), JSON.stringify(sample), streamId, streamId).run();

    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ runModuleAlarm }),
      },
    } as unknown as Env;
    const response = await panelRouter.fetch(await requestFor({ enabled: false }, ""), environment);

    expect(response.status).toBe(200);
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "ensure", "poll");
    await expect(database.prepare(
      "SELECT ended_at FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, streamId).first()).resolves.toEqual({ ended_at: null });
    await handleBelaboxPollAlarm({
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      streamState: () => Promise.resolve("online"),
      streamStartedAt: () => Promise.resolve({ streamId, startedAt }),
      schedule: () => Promise.resolve(),
    } as unknown as Parameters<typeof handleBelaboxPollAlarm>[0], BELABOX_POLL_ALARM_KEY, Date.now());
    const summary = await database.prepare(
      "SELECT ended_at, bitrate_p10 FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, streamId).first<{ ended_at: string | null; bitrate_p10: number | null }>();
    expect(summary?.ended_at).not.toBeNull();
    expect(summary?.bitrate_p10).toBe(3_200);
  });

  it("reopens and finalizes a stream summary only when the poll alarm sees current state", async () => {
    const streamId = "belabox-resumed-online-stream";
    const startedAt = "2026-10-07T09:00:00.000Z";
    const sample = {
      at: "2026-10-07T09:10:00.000Z",
      connected: true,
      bitrateKbps: 3_200,
      rttMs: 41,
      latencyMs: 115,
      network: 2,
      droppedPackets: 10,
    };
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at, stream_id)
       VALUES (?, 'online', ?, 'eventsub', ?, ?)`,
    ).bind(CHANNEL_ID, startedAt, startedAt, streamId).run();
    await database.prepare(
      `INSERT INTO belabox_streams
        (channel_id, stream_id, started_at, ended_at, samples, bitrate_avg, bitrate_p10)
       VALUES (?, ?, ?, '2026-10-07T09:20:00.000Z', 1, 3_200, 3_200)`,
    ).bind(CHANNEL_ID, streamId, startedAt).run();
    await database.prepare(
      `INSERT INTO belabox_minutes
        (channel_id, minute_at, stream_id, samples, connected_samples, bitrate_min, bitrate_max,
         bitrate_sum, rtt_max, rtt_sum, dropped_delta)
       VALUES (?, '2026-10-07T09:10:00.000Z', ?, 1, 1, 3_200, 3_200, 3_200, 41, 41, 10)`,
    ).bind(CHANNEL_ID, streamId).run();
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, sampled_at, sample_json, history_sample_json, polling, stream_id,
         belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, ?, ?, ?, 0, ?, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, sample.at, JSON.stringify(sample), JSON.stringify(sample), streamId, streamId).run();
    await database.prepare(
      `INSERT INTO module_secrets
        (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by)
       VALUES (?, 'belabox', 'stats_url', 'ciphertext-version', 'test', 1, ?, 'tester')`,
    ).bind(CHANNEL_ID, startedAt).run();

    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ runModuleAlarm }),
      },
    } as unknown as Env;
    const disabled = await panelRouter.fetch(await requestFor({ enabled: false }, ""), environment);
    expect(disabled.status).toBe(200);
    const enabled = await panelRouter.fetch(await requestFor({ enabled: true }, ""), environment);
    expect(enabled.status).toBe(200);

    await expect(database.prepare(
      "SELECT ended_at, bitrate_p10 FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, streamId).first()).resolves.toEqual({ ended_at: "2026-10-07T09:20:00.000Z", bitrate_p10: 3_200 });
    await expect(database.prepare(
      "SELECT history_sample_json FROM belabox_status WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ history_sample_json: JSON.stringify(sample) });

    const pollContext = {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      streamState: () => Promise.resolve("online"),
      streamStartedAt: () => Promise.resolve({ streamId, startedAt }),
      secrets: {
        readWithVersion: () => Promise.resolve({ value: "http://relay.belabox.net:8080/publisher", version: "ciphertext-version" }),
      },
      schedule: () => Promise.resolve(),
    } as unknown as Parameters<typeof handleBelaboxPollAlarm>[0];
    await handleBelaboxPollAlarm(
      pollContext,
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
      undefined,
      () => Promise.resolve(Response.json({ publishers: { publisher: {
        connected: true, bitrate: 3_200, rtt: 41, latency: 115, network: 2, dropped_pkts: 10,
      } } })),
    );
    await expect(database.prepare(
      "SELECT ended_at, bitrate_p10 FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, streamId).first()).resolves.toEqual({ ended_at: null, bitrate_p10: null });

    await database.prepare(
      "UPDATE channel_stream_state SET state = 'offline', changed_at = ?, stream_id = NULL WHERE channel_id = ?",
    ).bind("2026-10-07T09:21:00.000Z", CHANNEL_ID).run();
    await handleBelaboxPollAlarm({
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      streamState: () => Promise.resolve("offline"),
      streamStartedAt: () => Promise.resolve({ streamId: null, startedAt: null }),
      secrets: pollContext.secrets,
      schedule: () => Promise.resolve(),
    } as unknown as Parameters<typeof handleBelaboxPollAlarm>[0], BELABOX_POLL_ALARM_KEY, Date.now());

    const finalized = await database.prepare(
      "SELECT ended_at, bitrate_p10 FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, streamId).first<{ ended_at: string | null; bitrate_p10: number | null }>();
    expect(finalized?.ended_at).not.toBeNull();
    expect(finalized?.bitrate_p10).toBe(3_200);
  });
});
