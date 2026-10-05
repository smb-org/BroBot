import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { format } from "node:util";

import type { ModuleExternalFetchBudget, ModuleRouteEnvironment } from "../../src/modules/contract";
import { belaboxModule } from "../../src/modules/belabox";
import { BELABOX_STATS_TIMEOUT_MS, BELABOX_STATS_URL_SECRET, type BelaboxFetchFailureReason } from "../../src/modules/belabox/contracts";
import { fetchRelaySample } from "../../src/modules/belabox/adapters/stats-client";
import { belaboxRoutes } from "../../src/modules/belabox/routes";
import { parseRelayStats } from "../../src/modules/belabox/domain/stats";
import { publisherKeyFromUrl, validateBelaboxStatsUrl } from "../../src/modules/belabox/domain/stats-url";
import { prepareModuleAudit } from "../../src/worker/module-audit";
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
  const runModuleAlarm = vi.fn(() => Promise.resolve());
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "manager");
    context.set("actor", { userId: MANAGER_ID, sessionId: `session-${MANAGER_ID}` });
    context.set("authorizeManagementMutation", authorizeModuleManagementMutation);
    context.set("secrets", () => secrets);
    context.set("externalFetchBudget", sharedBudget());
    context.set("runModuleAlarm", runModuleAlarm);
    context.set("prepareModuleAudit", (entry, changedAt) => prepareModuleAudit(db, MANAGER_ID, changedAt, entry));
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
      defaultSettings: { mode: "interval", intervalSeconds: 15 },
      eventSubTypes: ["stream.online", "stream.offline"],
      settingsChangedAlarm: { handlerKey: "poll", alarmKey: "poll" },
    });
    expect(belaboxModule.settingsSchema.parse({})).toEqual({ mode: "interval", intervalSeconds: 15 });
    expect(belaboxModule.settingsSchema.safeParse({ mode: "on_demand", intervalSeconds: 60 }).success).toBe(true);
    expect(belaboxModule.settingsSchema.safeParse({ mode: "interval", intervalSeconds: 10 }).success).toBe(false);
    expect(belaboxModule.settingsEditor).toBeTypeOf("function");
    expect(belaboxModule.alarms?.map(({ key }) => key)).toEqual(["poll"]);
    const editor = await belaboxModule.settingsEditor?.();
    expect(editor?.default.spec.sections).toMatchObject([{ fields: [
      { kind: "segment", key: "mode", options: [{ value: "interval" }, { value: "on_demand" }] },
      { kind: "segment", key: "intervalSeconds", options: [
        { value: 5 }, { value: 15 }, { value: 30 }, { value: 60 },
      ] },
    ] }]);
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
    expect(statusBody).toContain("bitrateKbps");
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

  it("reconciles polling after the stats URL changes", async () => {
    const testDatabase = new TestD1Database();
    database = testDatabase;
    const { runModuleAlarm, send } = await createBelaboxRouteHarness(testDatabase);

    expect((await send("/stats-url", "PUT", { url: STATS_URL })).status).toBe(200);
    expect(runModuleAlarm).toHaveBeenLastCalledWith(CHANNEL_ID, "belabox", "poll", "poll");

    expect((await send("/stats-url", "DELETE")).status).toBe(200);
    expect(runModuleAlarm).toHaveBeenCalledTimes(2);
    expect(runModuleAlarm).toHaveBeenLastCalledWith(CHANNEL_ID, "belabox", "poll", "poll");
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
