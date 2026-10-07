import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { format } from "node:util";

import type { ModuleAlarmContext, ModuleExternalFetchBudget, ModuleRouteEnvironment } from "../../src/modules/contract";
import { belaboxModule } from "../../src/modules/belabox";
import { BELABOX_DEFAULT_SETTINGS, BELABOX_STATS_TIMEOUT_MS, BELABOX_STATS_URL_SECRET, type BelaboxFetchFailureReason } from "../../src/modules/belabox/contracts";
import { fetchRelaySample } from "../../src/modules/belabox/adapters/stats-client";
import { handleBelaboxPollAlarm } from "../../src/modules/belabox/service";
import { belaboxRoutes } from "../../src/modules/belabox/routes";
import { parseRelayStats } from "../../src/modules/belabox/domain/stats";
import { publisherKeyFromUrl, validateBelaboxStatsUrl } from "../../src/modules/belabox/domain/stats-url";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { writeModuleDiagnostics } from "../../src/worker/event-log";
import { authorizeModuleManagementMutation } from "../../src/worker/module-authorization";
import { createModuleSecretAccess } from "../../src/worker/module-secrets";
import { insertChannel, insertLoginIdentityAndSession, insertMember, jsonResponse, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "belabox-test-channel";
const MANAGER_ID = "belabox-test-manager";
const SENTINEL_KEY = "BELABOX_SENTINEL_320_7F3A";
const STATS_URL = `http://relay.belabox.net:8080/${SENTINEL_KEY}`;
const TOKEN_ENCRYPTION_KEYS = JSON.stringify({
  active: { id: "test-key", key: testKey(52) },
  retired: [],
});

const sharedBudget = (allowed = true): ModuleExternalFetchBudget => ({ claim: () => allowed });

const relayPayload = (publisherKey: string) => ({
  publishers: {
    [publisherKey]: {
      connected: true,
      bitrate: 2_400,
      rtt: 45,
      latency: 125,
      network: 3,
      dropped_pkts: 8,
    },
  },
  consumers: [],
});

const createBelaboxRouteHarness = async (testDatabase: TestD1Database) => {
  await insertChannel(testDatabase, CHANNEL_ID);
  await insertLoginIdentityAndSession(testDatabase, MANAGER_ID);
  await insertMember(testDatabase, CHANNEL_ID, MANAGER_ID, "manager");
  const db = testDatabase as unknown as D1Database;
  const secrets = createModuleSecretAccess({ DB: db, TOKEN_ENCRYPTION_KEYS }, CHANNEL_ID, "belabox");
  const runModuleAlarm = vi.fn(async (
    channelId: string,
    moduleId: string,
    handlerKey: string,
    alarmKey: string,
    invocation?: unknown,
  ) => {
    if (moduleId !== "belabox" || handlerKey !== "poll") return undefined;
    const context = {
      DB: db,
      channelId,
      secrets,
      externalFetchBudget: sharedBudget(),
      streamState: async () => {
        const row = await db.prepare("SELECT state FROM channel_stream_state WHERE channel_id = ?")
          .bind(channelId).first<{ state: string }>();
        return row?.state === "online" || row?.state === "offline" ? row.state : "unknown";
      },
      streamStartedAt: async () => {
        const row = await db.prepare("SELECT stream_id, started_at FROM channel_stream_state WHERE channel_id = ?")
          .bind(channelId).first<{ stream_id: string | null; started_at: string | null }>();
        return { streamId: row?.stream_id ?? null, startedAt: row?.started_at ?? null };
      },
      schedule: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      getAlarmDeadline: () => Promise.resolve(null),
      renderTemplate: (text: string) => Promise.resolve({ text, attributions: [] }),
      sendChat: () => Promise.resolve({ sent: true, reason: null, retryable: false }),
      writeDiagnostics: (triggerId: string, entries: Parameters<typeof writeModuleDiagnostics>[5], now: string) =>
        writeModuleDiagnostics(db, channelId, "belabox", triggerId, null, entries, now),
      publishModuleOverlayMessage: () => Promise.resolve(),
    } as unknown as ModuleAlarmContext;
    return handleBelaboxPollAlarm(context, alarmKey, Date.now(), undefined, fetch, invocation);
  });
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "manager");
    context.set("actor", { userId: MANAGER_ID, sessionId: `session-${MANAGER_ID}` });
    context.set("authorizeManagementMutation", authorizeModuleManagementMutation);
    context.set("secrets", () => secrets);
    context.set("externalFetchBudget", sharedBudget());
    context.set("runModuleAlarm", runModuleAlarm);
    context.set("prepareModuleAudit", (entry, changedAt) => prepareModuleAudit(db, MANAGER_ID, changedAt, entry));
    context.set("writeModuleDiagnostics", writeModuleDiagnostics);
    await next();
  });
  app.route(`/channels/:channelId/modules/belabox`, belaboxRoutes);

  const send = (path: string, method: string, body?: unknown): Promise<Response> => Promise.resolve(app.fetch(new Request(
    `https://brobot.example/channels/${CHANNEL_ID}/modules/belabox${path}`,
    {
      method,
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    },
  ), { DB: db }));
  return { app, db, secrets, runModuleAlarm, send };
};

const renderConsoleValue = (value: unknown, seen = new Set<object>()): string => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const rendered: string[] = [];
  if (value instanceof Error) {
    rendered.push(value.name, value.message, value.stack ?? "");
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) rendered.push(renderConsoleValue(key, seen), renderConsoleValue(entry, seen));
  } else if (value instanceof Set) {
    for (const entry of value) rendered.push(renderConsoleValue(entry, seen));
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      rendered.push(String(key), renderConsoleValue(descriptor.value, seen));
    }
  }
  return rendered.join(" ");
};

const expectConsoleCallsRedacted = (calls: readonly unknown[][]): void => {
  const rendered = calls.map((args) => `${format(...args)} ${args.map((value) => renderConsoleValue(value)).join(" ")}`).join("\n");
  expect(rendered).not.toContain(SENTINEL_KEY);
};

describe("BELABOX stats URL", () => {
  it("registers interval polling defaults and a settings editor", async () => {
    expect(belaboxModule).toMatchObject({
      id: "belabox",
      navigationCategory: "data",
      mandatory: false,
      defaultEnabled: false,
      defaultSettings: BELABOX_DEFAULT_SETTINGS,
      eventSubTypes: ["stream.online", "stream.offline"],
      settingsChangedAlarm: { handlerKey: "ensure", alarmKey: "poll" },
    });
    expect(belaboxModule.settingsSchema.parse({})).toEqual(BELABOX_DEFAULT_SETTINGS);
    expect(belaboxModule.settingsSchema.safeParse({ ...BELABOX_DEFAULT_SETTINGS, mode: "on_demand", intervalSeconds: 60, holdSeconds: 60, recoverHoldSeconds: 60 }).success).toBe(true);
    expect(belaboxModule.settingsSchema.safeParse({ mode: "interval", intervalSeconds: 10 }).success).toBe(false);
    expect(belaboxModule.settingsEditor).toBeTypeOf("function");
    expect(belaboxModule.alarms?.map(({ key }) => key)).toEqual(["poll", "ensure"]);
    const editor = await belaboxModule.settingsEditor?.();
    expect(editor?.default.spec.sections[0]?.fields).toMatchObject([
      { kind: "segment", key: "mode", options: [{ value: "interval" }, { value: "on_demand" }] },
      { kind: "segment", key: "intervalSeconds", options: [
        { value: 5 }, { value: 15 }, { value: 30 }, { value: 60 },
      ] },
    ]);
    const alertCard = editor?.default.spec.sections[1]?.fields[0];
    if (alertCard?.kind !== "switchCard") throw new Error("BELABOX alert settings card is missing.");
    expect(alertCard.key).toBe("alertsEnabled");
    expect(alertCard.children?.map(({ key }) => key)).toEqual([
      "lowBitrateKbps", "recoverBitrateKbps", "holdSeconds", "recoverHoldSeconds", "chatEnabled",
    ]);
    const recoveryThreshold = alertCard.children?.find(({ key }) => key === "recoverBitrateKbps");
    if (recoveryThreshold?.kind !== "number") throw new Error("BELABOX recovery threshold field is missing.");
    expect(recoveryThreshold.validate?.(1_000, BELABOX_DEFAULT_SETTINGS)).toBe(false);
    const chatCard = alertCard.children?.find(({ key }) => key === "chatEnabled");
    if (chatCard?.kind !== "switchCard") throw new Error("BELABOX chat settings card is missing.");
    expect(chatCard.children?.map(({ key }) => key)).toEqual([
      "chatCooldownSeconds", "lowText", "lowTarget", "disconnectText", "disconnectTarget", "recoveryText", "recoveryTarget",
    ]);
  });

  it("accepts the explicit HTTP port and HTTPS default port with one key segment", () => {
    const http = validateBelaboxStatsUrl("http://relay-1.belabox.net:8080/Publisher_key-123");
    const https = validateBelaboxStatsUrl("https://relay.belabox.net:443/abcdefgh");

    expect(http.ok).toBe(true);
    if (http.ok) expect(http.publisherKey).toBe("Publisher_key-123");
    expect(https.ok).toBe(true);
    if (https.ok) {
      expect(https.url.port).toBe("");
      expect(publisherKeyFromUrl(https.url)).toBe("abcdefgh");
    }
  });

  it.each([
    "http://relay.belabox.net/abcdefgh",
    "http://relay.belabox.net:80/abcdefgh",
    "http://relay.belabox.net:443/abcdefgh",
    "http://relay.belabox.net:8443/abcdefgh",
    "https://relay.belabox.net:8080/abcdefgh",
    "https://belabox.net/abcdefgh",
    "https://nested.relay.belabox.net/abcdefgh",
    "https://relay.belabox.net.evil.example/abcdefgh",
    "https://relay-bbelabox.net/abcdefgh",
    "https://relay.belabox.net./abcdefgh",
    "http://127.0.0.1:8080/abcdefgh",
    "http://[::1]:8080/abcdefgh",
    "http://relay.belabox.net:8080/abcdefgh/ijklmnop",
    "http://relay.belabox.net:8080/%41bcdefgh",
    "http://relay.belabox.net:8080/abcdefgh?",
    "http://relay.belabox.net:8080/abcdefgh#",
    "http://user@relay.belabox.net:8080/abcdefgh",
  ])("rejects disallowed URL %s without reflecting it", (value) => {
    const result = validateBelaboxStatsUrl(value);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(value);
  });
});

describe("BELABOX relay stats parsing and fetch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("selects only the matching publisher and treats a missing publisher as disconnected", () => {
    expect(parseRelayStats(relayPayload("selected-key"), "selected-key")).toEqual({
      connected: true,
      bitrateKbps: 2_400,
      rttMs: 45,
      latencyMs: 125,
      network: 3,
      droppedPackets: 8,
    });
    expect(parseRelayStats(relayPayload("other-key"), "selected-key")).toEqual({
      connected: false,
      bitrateKbps: 0,
      rttMs: 0,
      latencyMs: 0,
      network: 0,
      droppedPackets: 0,
    });
    expect(() => parseRelayStats({ publishers: [] }, "selected-key")).toThrow("Malformed relay stats.");
  });

  it("uses a bounded GET with a three-second timeout and no redirect or credential following", async () => {
    const validated = validateBelaboxStatsUrl(STATS_URL);
    if (!validated.ok) throw new Error("Test URL should be valid.");
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(relayPayload(SENTINEL_KEY)));

    const result = await fetchRelaySample(validated.url, SENTINEL_KEY, sharedBudget(), fetcher);
    const [, request] = fetcher.mock.calls[0] ?? [];

    expect(result).toMatchObject({ ok: true, sample: { connected: true, bitrateKbps: 2_400 } });
    expect(request).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(new Headers(request?.headers).get("Accept")).toBe("application/json");
    expect(timeoutSpy).toHaveBeenCalledWith(BELABOX_STATS_TIMEOUT_MS);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["timeout", (url: string) => Promise.reject(new DOMException(url, "TimeoutError"))],
    ["network", (url: string) => Promise.reject(new TypeError(`Network failed for ${url}`))],
  ] as const)("maps %s fetch failures without throwing", async (reason, fetcherFor) => {
    const validated = validateBelaboxStatsUrl(STATS_URL);
    if (!validated.ok) throw new Error("Test URL should be valid.");
    const result = await fetchRelaySample(validated.url, SENTINEL_KEY, sharedBudget(), fetcherFor as typeof fetch);
    expect(result).toEqual({ ok: false, reason });
  });

  it.each([
    [400, "http_4xx"],
    [500, "http_5xx"],
    [302, "redirect_rejected"],
  ] as const)("maps HTTP %i to %s without reading redirect metadata", async (status, expected) => {
    const validated = validateBelaboxStatsUrl(STATS_URL);
    if (!validated.ok) throw new Error("Test URL should be valid.");
    const response = new Response(STATS_URL, {
      status,
      headers: status === 302 ? { Location: STATS_URL } : {},
    });
    const locationRead = vi.spyOn(response.headers, "get");
    const result = await fetchRelaySample(validated.url, SENTINEL_KEY, sharedBudget(), () => Promise.resolve(response));

    expect(result).toEqual({ ok: false, reason: expected satisfies BelaboxFetchFailureReason });
    if (status === 302) expect(locationRead).not.toHaveBeenCalledWith("Location");
  });

  it("maps oversized, malformed, and exhausted responses to fixed reason codes", async () => {
    const validated = validateBelaboxStatsUrl(STATS_URL);
    if (!validated.ok) throw new Error("Test URL should be valid.");
    const oversized = new Response("x".repeat(16 * 1024 + 1));
    const malformed = new Response("not json");
    await expect(fetchRelaySample(validated.url, SENTINEL_KEY, sharedBudget(), () => Promise.resolve(oversized)))
      .resolves.toEqual({ ok: false, reason: "too_large" });
    await expect(fetchRelaySample(validated.url, SENTINEL_KEY, sharedBudget(), () => Promise.resolve(malformed)))
      .resolves.toEqual({ ok: false, reason: "malformed" });
    await expect(fetchRelaySample(validated.url, SENTINEL_KEY, sharedBudget(false), vi.fn<typeof fetch>()))
      .resolves.toEqual({ ok: false, reason: "budget_exhausted" });
  });
});

describe("BELABOX secret and route redaction", () => {
  let database: TestD1Database | null = null;
  let consoleSpies: Array<{ mock: { calls: unknown[][] }; getMockName: () => string }>;

  afterEach(() => {
    database?.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps connection tests using an ad hoc URL out of history lifecycle state", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { send, db } = await createBelaboxRouteHarness(testDatabase);
    const sample = {
      at: "2026-10-05T12:00:00.000Z",
      connected: true,
      bitrateKbps: 2_400,
      rttMs: 45,
      latencyMs: 125,
      network: 3,
      droppedPackets: 8,
    };
    await db.prepare(
      `INSERT INTO belabox_status (channel_id, history_sample_json)
       VALUES (?, ?)`,
    ).bind(CHANNEL_ID, JSON.stringify(sample)).run();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(relayPayload(SENTINEL_KEY)))));

    const response = await send("/test", "POST", { url: STATS_URL });

    expect(response.status).toBe(200);
    await expect(db.prepare(
      "SELECT history_sample_json FROM belabox_status WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ history_sample_json: JSON.stringify(sample) });
  });

  it("exposes notices only after three failures on the current classified BELABOX stream", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { send } = await createBelaboxRouteHarness(testDatabase);
    const streamId = "stream-alert-323";
    await testDatabase.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify(BELABOX_DEFAULT_SETTINGS)).run();
    await testDatabase.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id)
       VALUES (?, 'online', ?, 'eventsub', ?)`,
    ).bind(CHANNEL_ID, new Date().toISOString(), streamId).run();
    await testDatabase.prepare(
      `INSERT INTO belabox_status
        (channel_id, sampled_at, sample_json, error_code, polling, stream_id, belabox_stream_id,
         fetch_phase_json, recent_json, alert_json, revision)
       VALUES (?, ?, ?, 'network', 1, ?, ?, ?, '[]', ?, 1)`,
    ).bind(
      CHANNEL_ID,
      new Date().toISOString(),
      JSON.stringify({ at: new Date().toISOString(), connected: true, bitrateKbps: 800, rttMs: 20, latencyMs: 50, network: 1, droppedPackets: 0 }),
      streamId,
      streamId,
      JSON.stringify({ consecutiveFailures: 2, fetchFailing: false }),
      JSON.stringify({ phase: "alarm", kind: "low", since: null, episodeStartedAt: new Date().toISOString(), completedEpisodeAt: null, lastChatSentAt: null, chatSentInEpisode: false, pendingChat: null }),
    ).run();

    const twoFailures = await send("/status", "GET");
    await expect(twoFailures.json()).resolves.toMatchObject({
      alertNotice: { phase: "alarm", kind: "low", bitrateKbps: 800 },
      fetchFailureNotice: false,
    });
    await testDatabase.prepare("UPDATE belabox_status SET fetch_phase_json = ? WHERE channel_id = ?")
      .bind(JSON.stringify({ consecutiveFailures: 3, fetchFailing: true }), CHANNEL_ID).run();
    const threeFailures = await send("/status", "GET");
    await expect(threeFailures.json()).resolves.toMatchObject({ fetchFailureNotice: true });

    await testDatabase.prepare("UPDATE belabox_status SET belabox_stream_id = NULL WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    const unclassified = await send("/status", "GET");
    await expect(unclassified.json()).resolves.toMatchObject({ alertNotice: null, fetchFailureNotice: false });
  });

  it("keeps a sentinel URL out of logs, route results, audits, events, and module rows for every fetch outcome", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const harness = await createBelaboxRouteHarness(testDatabase);
    const { send } = harness;

    const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => void>;
    const spyNames = Object.getOwnPropertyNames(consoleRecord).filter((name) => typeof consoleRecord[name] === "function");
    consoleSpies = spyNames.map((name) => vi.spyOn(consoleRecord, name));
    console.error(new TypeError(`Network failed for ${STATS_URL}`, {
      cause: new Error("Wrapped fetch error", { cause: SENTINEL_KEY }),
    }));
    expect(() => { expectConsoleCallsRedacted(consoleSpies.flatMap((spy) => spy.mock.calls)); }).toThrow();
    for (const spy of consoleSpies) spy.mock.calls.splice(0);
    const assertDatabaseRedacted = async (): Promise<void> => {
      const tableNames = (await testDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>())
        .results.map(({ name }) => name);
      for (const table of tableNames) {
        const rows = await testDatabase.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
        expect(JSON.stringify(rows.results), table).not.toContain(SENTINEL_KEY);
      }
    };

    const stored = await send("/stats-url", "PUT", { url: STATS_URL });
    expect(stored.status).toBe(200);
    expect(await stored.text()).not.toContain(SENTINEL_KEY);
    await assertDatabaseRedacted();

    const invalid = await send("/stats-url", "PUT", { url: `http://not-bbelabox.example:8080/${SENTINEL_KEY}` });
    const invalidBody = await invalid.text();
    expect(invalid.status).toBe(400);
    expect(invalidBody).not.toContain(SENTINEL_KEY);
    expect(JSON.parse(invalidBody) as unknown).toEqual({ error: "belabox_stats_url_invalid_host" });

    const attempts: readonly [string, () => Promise<Response>][] = [
      ["network", () => Promise.reject(new TypeError(`Failed to fetch ${STATS_URL}`))],
      ["http_5xx", () => Promise.resolve(new Response(STATS_URL, { status: 500 }))],
      ["redirect_rejected", () => Promise.resolve(new Response(null, { status: 302, headers: { Location: STATS_URL } }))],
      ["timeout", () => Promise.reject(new DOMException(STATS_URL, "TimeoutError"))],
      ["publisher", () => Promise.resolve(jsonResponse(relayPayload(SENTINEL_KEY)))],
    ];

    for (const [kind, responseFor] of attempts) {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(responseFor));
      let response: Response | null = null;
      let thrownText = "";
      try {
        response = await send("/test", "POST", {});
      } catch (error: unknown) {
        thrownText = String(error);
      }
      expect(thrownText, kind).not.toContain(SENTINEL_KEY);
      expect(thrownText, kind).toBe("");
      if (response === null) continue;
      const body = await response.text();
      expect(response.status, kind).toBe(200);
      expect(body, kind).not.toContain(SENTINEL_KEY);
      if (kind === "network") expect(JSON.parse(body) as unknown).toEqual({ ok: false, reason: "network" });
      if (kind === "publisher") {
        expect(JSON.parse(body) as unknown).toEqual({ ok: true, connected: true, bitrateKbps: 2_400 });
      }
    }

    const status = await send("/status", "GET");
    const statusBody = await status.text();
    expect(statusBody).not.toContain(SENTINEL_KEY);
    expect(statusBody).toContain('"sample":null');
    await assertDatabaseRedacted();

    const removed = await send("/stats-url", "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.text()).not.toContain(SENTINEL_KEY);
    const auditRows = await testDatabase.prepare(
      "SELECT action, before_json, after_json FROM audit_log ORDER BY rowid",
    ).all<{ action: string; before_json: string; after_json: string }>();
    expect(auditRows.results).toEqual([
      { action: "module.secret.replaced", before_json: "null", after_json: JSON.stringify({ statsUrl: "replaced" }) },
      { action: "module.secret.removed", before_json: JSON.stringify({ statsUrl: "configured" }), after_json: JSON.stringify({ statsUrl: "removed" }) },
    ]);

    await assertDatabaseRedacted();
    expectConsoleCallsRedacted(consoleSpies.flatMap((spy) => spy.mock.calls));
  });

  it("ensures the poll alarm after the stats URL changes", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { runModuleAlarm, send } = await createBelaboxRouteHarness(testDatabase);

    expect((await send("/stats-url", "PUT", { url: STATS_URL })).status).toBe(200);
    expect(runModuleAlarm).toHaveBeenLastCalledWith(CHANNEL_ID, "belabox", "ensure", "poll");

    expect((await send("/stats-url", "DELETE")).status).toBe(200);
    expect(runModuleAlarm).toHaveBeenCalledTimes(2);
    expect(runModuleAlarm).toHaveBeenLastCalledWith(CHANNEL_ID, "belabox", "ensure", "poll");
  });

  it("returns success after URL mutations commit when ensure fails", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { runModuleAlarm, send, secrets } = await createBelaboxRouteHarness(testDatabase);
    runModuleAlarm.mockRejectedValue(new Error("storage details must stay hidden"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const saved = await send("/stats-url", "PUT", { url: STATS_URL });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({ configured: true });
    await expect(secrets.status(BELABOX_STATS_URL_SECRET)).resolves.toMatchObject({ configured: true });

    const removed = await send("/stats-url", "DELETE");
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ configured: false });
    await expect(secrets.status(BELABOX_STATS_URL_SECRET)).resolves.toMatchObject({ configured: false });
    expect(runModuleAlarm).toHaveBeenCalledTimes(2);
    expect(runModuleAlarm).toHaveBeenNthCalledWith(1, CHANNEL_ID, "belabox", "ensure", "poll");
    expect(runModuleAlarm).toHaveBeenNthCalledWith(2, CHANNEL_ID, "belabox", "ensure", "poll");
    expect(warning).not.toHaveBeenCalled();
    const diagnostics = await testDatabase.prepare(
      "SELECT code FROM event_log WHERE channel_id = ? ORDER BY rowid",
    ).bind(CHANNEL_ID).all<{ code: string }>();
    expect(diagnostics.results).toEqual([
      { code: "belabox.polling_ensure_failed" },
      { code: "belabox.polling_ensure_failed" },
    ]);
  });

  it("shows inactive desired polling after a committed save and lets a manager retry ensure", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { runModuleAlarm, send } = await createBelaboxRouteHarness(testDatabase);
    await testDatabase.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({ mode: "interval", intervalSeconds: 15 })).run();
    await testDatabase.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(CHANNEL_ID, new Date().toISOString()).run();
    runModuleAlarm.mockRejectedValueOnce(new Error(`secret details ${STATS_URL}`));

    const saved = await send("/stats-url", "PUT", { url: STATS_URL });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({ configured: true });

    const status = await send("/status", "GET");
    await expect(status.json()).resolves.toMatchObject({
      polling: false,
      pollingDesired: true,
    });

    const retried = await send("/polling/retry", "POST");
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toEqual({ ensured: true });
    expect(runModuleAlarm).toHaveBeenNthCalledWith(1, CHANNEL_ID, "belabox", "ensure", "poll");
    expect(runModuleAlarm).toHaveBeenNthCalledWith(2, CHANNEL_ID, "belabox", "poll", "poll", { reason: "check_now" });
    const diagnostics = await testDatabase.prepare(
      "SELECT code FROM event_log WHERE channel_id = ? ORDER BY rowid",
    ).bind(CHANNEL_ID).all<{ code: string }>();
    expect(diagnostics.results).toEqual([{ code: "belabox.polling_ensure_failed" }]);
  });

  it("fetches status on demand and then reuses the ten-second cache", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { send } = await createBelaboxRouteHarness(testDatabase);
    await testDatabase.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({ mode: "on_demand", intervalSeconds: 15 })).run();
    expect((await send("/stats-url", "PUT", { url: STATS_URL })).status).toBe(200);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(relayPayload(SENTINEL_KEY)));
    vi.stubGlobal("fetch", fetcher);

    const first = await send("/status", "GET");
    const second = await send("/status", "GET");

    expect(await first.json()).toMatchObject({ sample: { connected: true, bitrateKbps: 2_400 }, polling: false });
    expect(await second.json()).toMatchObject({ sample: { connected: true, bitrateKbps: 2_400 }, polling: false });
    expect(fetcher).toHaveBeenCalledOnce();
    const history = await send("/history?range=live", "GET");
    await expect(history.json()).resolves.toEqual([]);
    await expect(testDatabase.prepare("SELECT COUNT(*) AS count FROM belabox_minutes WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });

  it("routes on-demand status, Check now, and connection tests through the poll alarm handler", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { runModuleAlarm, send } = await createBelaboxRouteHarness(testDatabase);
    await testDatabase.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({ mode: "on_demand", intervalSeconds: 15 })).run();
    await testDatabase.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id) VALUES (?, 'online', ?, 'eventsub', 'stream-routine')",
    ).bind(CHANNEL_ID, new Date().toISOString()).run();
    expect((await send("/stats-url", "PUT", { url: STATS_URL })).status).toBe(200);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(relayPayload(SENTINEL_KEY)))));

    expect((await send("/status", "GET")).status).toBe(200);
    expect((await send("/polling/retry", "POST")).status).toBe(200);
    expect((await send("/test", "POST", {})).status).toBe(200);

    expect(runModuleAlarm).toHaveBeenCalledWith(CHANNEL_ID, "belabox", "poll", "poll", { reason: "on_demand" });
    expect(runModuleAlarm).toHaveBeenCalledWith(CHANNEL_ID, "belabox", "poll", "poll", { reason: "check_now" });
    expect(runModuleAlarm).toHaveBeenCalledWith(CHANNEL_ID, "belabox", "poll", "poll", {
      reason: "connection_test",
      statsUrl: STATS_URL,
    });
  });

  it("returns only numeric history points and keeps stream reads channel-scoped", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { app } = await createBelaboxRouteHarness(testDatabase);
    await insertChannel(testDatabase, "other-belabox-channel");
    const sampledAt = new Date().toISOString();
    const minuteAt = `${sampledAt.slice(0, 16)}:00.000Z`;
    for (const channelId of [CHANNEL_ID, "other-belabox-channel"]) {
      const bitrate = channelId === CHANNEL_ID ? 3_200 : 4_100;
      await testDatabase.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES (?, 'belabox', 1, '{"mode":"interval","intervalSeconds":15}')`,
      ).bind(channelId).run();
      await testDatabase.prepare(
        `INSERT INTO belabox_status
          (channel_id, sampled_at, sample_json, polling, stream_id, belabox_stream_id,
           fetch_phase_json, recent_json, revision)
         VALUES (?, ?, NULL, 1, 'shared-stream', 'shared-stream', ?, ?, 1)`,
      ).bind(channelId, sampledAt, "{}", JSON.stringify([[sampledAt, bitrate, 41, true]])).run();
      await testDatabase.prepare(
        `INSERT INTO belabox_minutes
          (channel_id, minute_at, stream_id, samples, connected_samples, bitrate_min, bitrate_max,
           bitrate_sum, rtt_max, rtt_sum, dropped_delta)
         VALUES (?, ?, 'shared-stream', 1, 1, ?, ?, ?, 41, 41, 3)`,
      ).bind(channelId, minuteAt, bitrate, bitrate, bitrate).run();
      await testDatabase.prepare(
        `INSERT INTO belabox_streams
          (channel_id, stream_id, started_at, ended_at, samples, bitrate_avg, bitrate_p10,
           low_seconds, disconnected_seconds, disconnect_count, dropped_total)
         VALUES (?, 'shared-stream', '2026-10-05T11:00:00.000Z', NULL, 1, ?, NULL, 0, 0, 0, 3)`,
      ).bind(channelId, bitrate).run();
    }
    const sendFor = (channelId: string, path: string): Promise<Response> => Promise.resolve(app.fetch(new Request(
      `https://brobot.example/channels/${channelId}/modules/belabox${path}`,
    ), { DB: testDatabase as unknown as D1Database }));

    const live = await sendFor(CHANNEL_ID, "/history?range=live");
    const livePoints: unknown = await live.json();
    expect(livePoints).toEqual([[Date.parse(sampledAt), 3_200, 1]]);
    expect((livePoints as unknown[][]).flat().every((value) => typeof value === "number")).toBe(true);
    const stream = await sendFor(CHANNEL_ID, "/history?range=stream&streamId=shared-stream");
    await expect(stream.json()).resolves.toEqual([[Date.parse(minuteAt), 3_200, 1]]);
    const streams = await sendFor(CHANNEL_ID, "/streams");
    await expect(streams.json()).resolves.toMatchObject([{ streamId: "shared-stream", samples: 1 }]);
    const foreign = await sendFor("other-belabox-channel", "/history?range=stream&streamId=shared-stream");
    await expect(foreign.json()).resolves.toEqual([[Date.parse(minuteAt), 4_100, 1]]);
  });

  it.each(["interval", "on_demand"] as const)("routes POST /test through the poll routine without changing stored samples in %s mode", async (mode) => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { send } = await createBelaboxRouteHarness(testDatabase);
    await testDatabase.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({ mode, intervalSeconds: 15 })).run();
    expect((await send("/stats-url", "PUT", { url: STATS_URL })).status).toBe(200);

    const streamChangedAt = new Date(Date.now() - 90_000).toISOString();
    await testDatabase.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at, stream_id)
       VALUES (?, 'online', ?, 'eventsub', ?, 'stream-test')`,
    ).bind(CHANNEL_ID, streamChangedAt, streamChangedAt).run();

    const alertStartedAt = new Date(Date.now() - 60_000).toISOString();
    const previousAt = new Date(Date.now() - 30_000).toISOString();
    await testDatabase.prepare(
      `INSERT INTO belabox_status
        (channel_id, sampled_at, sample_json, polling, stream_id, stream_session_key, belabox_stream_id,
         fetch_phase_json, recent_json, revision)
       VALUES (?, ?, ?, 0, 'stream-test', 'stream:stream-test', 'stream-test', '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, previousAt, JSON.stringify({
      at: previousAt,
      connected: true,
      bitrateKbps: 800,
      rttMs: 45,
      latencyMs: 125,
      network: 3,
      droppedPackets: 4,
      droppedTotal: 5,
      phase: "low",
      alertStartedAt,
    })).run();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      publishers: {
        [SENTINEL_KEY]: {
          connected: true,
          bitrate: 800,
          rtt: 45,
          latency: 125,
          network: 3,
          dropped_pkts: 8,
        },
      },
    })));

    const tested = await send("/test", "POST", {});
    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toEqual({ ok: true, connected: true, bitrateKbps: 800 });
    const stored = await testDatabase.prepare(
      "SELECT sample_json FROM belabox_status WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first<{ sample_json: string }>();
    expect(JSON.parse(stored?.sample_json ?? "null") as unknown).toMatchObject({
      droppedTotal: 5,
      phase: "low",
      alertStartedAt,
    });
  });

  it("does not persist a connection test sample when its stream session changes during fetch", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { send } = await createBelaboxRouteHarness(testDatabase);
    await testDatabase.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({ mode: "on_demand", intervalSeconds: 15 })).run();
    expect((await send("/stats-url", "PUT", { url: STATS_URL })).status).toBe(200);
    const streamChangedAt = "2026-10-05T11:59:00.000Z";
    await testDatabase.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at, stream_id)
       VALUES (?, 'online', ?, 'eventsub', ?, 'stream-s1')`,
    ).bind(CHANNEL_ID, streamChangedAt, streamChangedAt).run();
    await testDatabase.prepare(
      `INSERT INTO belabox_status
        (channel_id, sampled_at, sample_json, polling, stream_id, stream_session_key, belabox_stream_id,
         fetch_phase_json, recent_json, revision)
       VALUES (?, ?, ?, 0, 'stream-s1', 'stream:stream-s1', 'stream-s1', '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, streamChangedAt, JSON.stringify({
      at: streamChangedAt,
      connected: true,
      bitrateKbps: 800,
      rttMs: 45,
      latencyMs: 125,
      network: 3,
      droppedPackets: 4,
      droppedTotal: 8,
      phase: "low",
      alertStartedAt: "2026-10-05T11:00:00.000Z",
    })).run();

    let finishFetch!: (response: Response) => void;
    let signalFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { signalFetch = resolve; });
    const responseFromFetch = new Promise<Response>((resolve) => { finishFetch = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => {
      signalFetch();
      return responseFromFetch;
    }));
    const testPending = send("/test", "POST", {});
    await fetchStarted;

    await testDatabase.prepare(
      `UPDATE channel_stream_state
          SET state = 'offline', changed_at = ?, started_at = NULL, stream_id = NULL
        WHERE channel_id = ?`,
    ).bind("2026-10-05T12:00:00.000Z", CHANNEL_ID).run();
    await testDatabase.prepare(
      `UPDATE belabox_status
          SET sampled_at = NULL, sample_json = NULL, stream_id = NULL, stream_session_key = NULL,
              belabox_stream_id = NULL, revision = revision + 1
        WHERE channel_id = ?`,
    ).bind(CHANNEL_ID).run();
    await testDatabase.prepare(
      `UPDATE channel_stream_state
          SET state = 'online', changed_at = ?, started_at = ?, stream_id = ?
        WHERE channel_id = ?`,
    ).bind("2026-10-05T12:00:05.000Z", "2026-10-05T12:00:05.000Z", "stream-s2", CHANNEL_ID).run();

    finishFetch(jsonResponse(relayPayload(SENTINEL_KEY)));
    const tested = await testPending;
    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toMatchObject({ ok: true });
    await expect(testDatabase.prepare(
      "SELECT sampled_at, sample_json, stream_id, stream_session_key, revision FROM belabox_status WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({
      sampled_at: null,
      sample_json: null,
      stream_id: null,
      stream_session_key: null,
      revision: 2,
    });
  });

  it("does not adopt a new stream session while validating the connection test URL", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { send } = await createBelaboxRouteHarness(testDatabase);
    await testDatabase.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({ mode: "on_demand", intervalSeconds: 15 })).run();
    expect((await send("/stats-url", "PUT", { url: STATS_URL })).status).toBe(200);
    const oldAt = "2026-10-05T11:59:00.000Z";
    const newStartedAt = "2026-10-05T12:00:05.000Z";
    await testDatabase.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at, stream_id)
       VALUES (?, 'online', ?, 'eventsub', ?, 'stream-s2')`,
    ).bind(CHANNEL_ID, newStartedAt, newStartedAt).run();
    await testDatabase.prepare(
      `INSERT INTO belabox_status
        (channel_id, sampled_at, sample_json, polling, stream_id, stream_session_key, belabox_stream_id,
         fetch_phase_json, recent_json, revision)
       VALUES (?, ?, ?, 0, 'stream-s1', 'stream:stream-s1', 'stream-s1', '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, oldAt, JSON.stringify({
      at: oldAt,
      connected: true,
      bitrateKbps: 400,
      rttMs: 45,
      latencyMs: 125,
      network: 3,
      droppedPackets: 4,
      droppedTotal: 8,
      phase: "low",
      alertStartedAt: "2026-10-05T11:00:00.000Z",
    })).run();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      publishers: {
        [SENTINEL_KEY]: {
          connected: true,
          bitrate: 400,
          rtt: 45,
          latency: 125,
          network: 3,
          dropped_pkts: 8,
        },
      },
    })));

    const tested = await send("/test", "POST", {});
    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toMatchObject({ ok: true, connected: true, bitrateKbps: 400 });
    const stored = await testDatabase.prepare(
      "SELECT sample_json, stream_id, stream_session_key FROM belabox_status WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first<{ sample_json: string; stream_id: string; stream_session_key: string }>();
    expect(JSON.parse(stored?.sample_json ?? "null") as unknown).toMatchObject({ droppedTotal: 8, phase: "low" });
    expect(stored).toMatchObject({ stream_id: "stream-s1", stream_session_key: "stream:stream-s1" });
  });

  it("rechecks management membership after the POST /test body finishes before reading the stored secret", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { app, db, secrets } = await createBelaboxRouteHarness(testDatabase);
    await secrets.prepareWrite(BELABOX_STATS_URL_SECRET, STATS_URL, {
      userId: MANAGER_ID,
      sessionId: `session-${MANAGER_ID}`,
    }, new Date().toISOString()).then((statement) => statement.run());
    const secretRead = vi.spyOn(secrets, "readWithVersion");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let notifyBodyRead!: () => void;
    const bodyRead = new Promise<void>((resolve) => { notifyBodyRead = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyController = controller;
        notifyBodyRead();
      },
    });
    const request = new Request(
      `https://brobot.example/channels/${CHANNEL_ID}/modules/belabox/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit,
    );
    const responsePending = app.fetch(request, { DB: db });
    await bodyRead;
    await testDatabase.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .bind(CHANNEL_ID, MANAGER_ID).run();
    bodyController?.enqueue(new TextEncoder().encode("{}"));
    bodyController?.close();

    const response = await responsePending;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "belabox_management_denied" });
    expect(secretRead).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["remove", "replace", "delete-then-recreate"] as const)("does not write a stale sample when the stored URL is changed during a test (%s)", async (change) => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { send, secrets } = await createBelaboxRouteHarness(testDatabase);
    await secrets.prepareWrite(BELABOX_STATS_URL_SECRET, STATS_URL, {
      userId: MANAGER_ID,
      sessionId: `session-${MANAGER_ID}`,
    }, new Date().toISOString()).then((statement) => statement.run());

    let finishFetch!: (response: Response) => void;
    let signalFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { signalFetch = resolve; });
    const responseFromFetch = new Promise<Response>((resolve) => { finishFetch = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => {
      signalFetch();
      return responseFromFetch;
    }));
    const testPending = send("/test", "POST", {});
    await fetchStarted;

    if (change === "delete-then-recreate") {
      expect((await send("/stats-url", "DELETE")).status).toBe(200);
      expect((await send("/stats-url", "PUT", { url: STATS_URL })).status).toBe(200);
    }
    const changed = change === "remove"
      ? await send("/stats-url", "DELETE")
      : change === "delete-then-recreate" ? { status: 200 } : await send("/stats-url", "PUT", { url: "http://relay.belabox.net:8080/replacement-publisher-key" });
    expect(changed.status).toBe(200);
    finishFetch(jsonResponse(relayPayload(SENTINEL_KEY)));
    const tested = await testPending;
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, connected: true });

    const status = await send("/status", "GET");
    expect(await status.json()).toMatchObject({
      configured: change !== "remove",
      sample: null,
    });
  });
});
