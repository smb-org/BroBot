import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ModuleTemplateValueContext } from "../../src/modules/contract";
import { belaboxModule } from "../../src/modules/belabox";
import { mergeModuleOverlayElementState, moduleOverlayElementKindForMessage } from "../../src/modules/overlay-element-registry";
import BelaboxStatus from "../../src/modules/belabox/overlay/status";
import BelaboxEditor from "../../src/modules/belabox/overlay/editor";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "belabox-template-channel";
const SECRET_KEY = "BELABOX_TEMPLATE_SECRET_322";
const STATS_URL = `http://relay.belabox.net:8080/${SECRET_KEY}`;

const sample = (at: string, overrides: Readonly<Record<string, unknown>> = {}) => ({
  at,
  connected: true,
  bitrateKbps: 4_520,
  rttMs: 38,
  latencyMs: 2_000,
  network: 2,
  droppedPackets: 17,
  droppedTotal: 9,
  phase: "healthy",
  alertStartedAt: null,
  ...overrides,
});

describe("BELABOX template variables and overlay metadata", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:30.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    database.close();
  });

  const insertModule = async (
    mode: "interval" | "on_demand" = "interval",
    intervalSeconds = 15,
    lowBitrateKbps = 1_000,
  ): Promise<void> => {
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({
      mode,
      intervalSeconds,
      lowBitrateKbps,
      recoverBitrateKbps: Math.max(lowBitrateKbps + 1, 2_000),
    })).run();
    await database.prepare(
      `INSERT INTO module_secrets
        (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by)
       VALUES (?, 'belabox', 'stats_url', 'ciphertext-version', 'test', 1, ?, 'tester')`,
    ).bind(CHANNEL_ID, "2026-10-06T00:00:00.000Z").run();
  };

  const insertStatus = async (
    value: Readonly<Record<string, unknown>>,
    errorCode: string | null = null,
    belaboxStreamId: string | null = "stream-322",
  ): Promise<void> => {
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at, stream_id)
       VALUES (?, 'online', '2026-10-06T11:59:00.000Z', 'eventsub', '2026-10-06T11:59:00.000Z', 'stream-322')`,
    ).bind(CHANNEL_ID).run();
    await database.prepare(
      `INSERT INTO belabox_status
         (channel_id, sampled_at, sample_json, error_code, polling, stream_id, stream_session_key, belabox_stream_id,
         fetch_phase_json, recent_json, revision)
       VALUES (?, ?, ?, ?, 1, 'stream-322', 'stream:stream-322', ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, String(value.at), JSON.stringify(value), errorCode, belaboxStreamId).run();
  };

  const templateContext = (
    language: "de" | "en" = "en",
    runModuleAlarm: ModuleTemplateValueContext["runModuleAlarm"] = vi.fn(() => Promise.resolve({
      ok: true,
      sample: sample(new Date().toISOString()),
    })),
  ): ModuleTemplateValueContext => ({
    DB: database as unknown as D1Database,
    channelId: CHANNEL_ID,
    secrets: {
      status: () => Promise.resolve({ configured: true, updatedAt: "2026-10-06T00:00:00.000Z" }),
      read: () => Promise.resolve(STATS_URL),
      readWithVersion: () => Promise.resolve({ value: STATS_URL, version: "ciphertext-version" }),
    },
    templateContext: "event",
    knownTemplateVariableNames: new Set(),
    chatStatus: null,
    mode: "preview",
    channelLanguage: () => Promise.resolve(language),
    streamState: () => Promise.resolve("online"),
    channelInfo: () => Promise.resolve(null),
    channelTimeZone: () => Promise.resolve("Europe/Berlin"),
    channelLocation: () => Promise.resolve(null),
    externalFetchBudget: { claim: () => true },
    runModuleAlarm,
    renderTemplate: () => Promise.resolve({ text: "", diagnostics: [] }),
    addDiagnostic: () => undefined,
    now: Date.now(),
    resolveTemplateConditions: () => Promise.resolve({}),
  });

  it("declares all localized external variables in the BELABOX picker group", () => {
    expect(belaboxModule.templateVariableGroup?.label).toEqual({ de: "BELABOX", en: "BELABOX" });
    expect(belaboxModule.templateUnavailableText).toEqual({
      de: "BELABOX-Daten nicht verfügbar",
      en: "BELABOX data unavailable",
    });
    expect(belaboxModule.templateVariableCatalog?.map(({ name }) => name)).toEqual([
      "belabox.bitrate",
      "belabox.bitrate_mbps",
      "belabox.rtt",
      "belabox.latency",
      "belabox.network",
      "belabox.dropped",
      "belabox.connected",
      "belabox.status",
      "belabox.down_for",
    ]);
    for (const variable of belaboxModule.templateVariableCatalog ?? []) {
      expect(variable.external).toBe(true);
      expect(variable.picker?.de.label.trim()).not.toBe("");
      expect(variable.picker?.en.description.trim()).not.toBe("");
    }
  });

  it("formats a fresh interval sample without fetching", async () => {
    await insertModule();
    await insertStatus(sample("2026-10-06T12:00:00.000Z"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const values = await belaboxModule.resolveTemplateValues?.(
      belaboxModule.templateVariableCatalog?.map(({ name }) => name) ?? [],
      templateContext("de"),
    );

    expect(values).toEqual({
      "belabox.bitrate": "4.520 kbps",
      "belabox.bitrate_mbps": "4,5 Mbit/s",
      "belabox.rtt": "38 ms",
      "belabox.latency": "2.000 ms",
      "belabox.network": "2",
      "belabox.dropped": "9",
      "belabox.connected": "verbunden",
      "belabox.status": "stabil",
      "belabox.down_for": "0 Sekunden",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats errors and samples older than three intervals as unavailable", async () => {
    await insertModule("interval", 15);
    await insertStatus(sample("2026-10-06T11:59:44.999Z"), "network");

    await expect(belaboxModule.resolveTemplateValues?.(["belabox.bitrate"], templateContext()))
      .rejects.toThrow("BELABOX_SAMPLE_UNAVAILABLE");
    await database.prepare("UPDATE belabox_status SET error_code = NULL").run();
    vi.setSystemTime(new Date("2026-10-06T12:00:30.000Z"));
    await database.prepare("UPDATE belabox_status SET sampled_at = ?, sample_json = ?")
      .bind("2026-10-06T11:59:44.999Z", JSON.stringify(sample("2026-10-06T11:59:44.999Z"))).run();
    await expect(belaboxModule.resolveTemplateValues?.(["belabox.bitrate"], templateContext()))
      .rejects.toThrow("BELABOX_SAMPLE_UNAVAILABLE");
  });

  it("uses a fresh relay sample in on-demand mode and applies the 30-second age", async () => {
    await insertModule("on_demand", 60);
    const runModuleAlarm = vi.fn(() => Promise.resolve({ ok: true, sample: sample(new Date().toISOString()) }));

    await expect(belaboxModule.resolveTemplateValues?.(["belabox.bitrate", "belabox.status"], templateContext("en", runModuleAlarm)))
      .resolves.toEqual({ "belabox.bitrate": "4,520 kbps", "belabox.status": "healthy" });
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "poll", "poll", { reason: "on_demand" });
  });

  it("checks an on-demand sample against real time after a delayed fetch", async () => {
    await insertModule("on_demand", 60);
    vi.useRealTimers();
    const runModuleAlarm = vi.fn(async () => {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
      return { ok: true, sample: sample(new Date().toISOString()) };
    });

    await expect(belaboxModule.resolveTemplateValues?.(["belabox.bitrate", "belabox.status"], templateContext("en", runModuleAlarm)))
      .resolves.toEqual({ "belabox.bitrate": "4,520 kbps", "belabox.status": "healthy" });
    expect(runModuleAlarm).toHaveBeenCalledTimes(1);
  });

  it("uses the enriched on-demand samples returned by the serialized poll routine", async () => {
    await insertModule("on_demand", 60);
    const startedAt = new Date(Date.now()).toISOString();
    const nextSampleAt = new Date(Date.now() + 60_000).toISOString();
    const runModuleAlarm = vi.fn()
      .mockResolvedValueOnce({ ok: true, sample: sample(startedAt, { bitrateKbps: 900, droppedTotal: 0, phase: "low" }) })
      .mockResolvedValueOnce({ ok: true, sample: sample(nextSampleAt, {
        bitrateKbps: 900,
        droppedTotal: 5,
        phase: "low",
        alertStartedAt: startedAt,
      }) });

    await expect(belaboxModule.resolveTemplateValues?.(["belabox.dropped", "belabox.down_for"], templateContext("en", runModuleAlarm)))
      .resolves.toEqual({ "belabox.dropped": "0", "belabox.down_for": "0 seconds" });
    vi.setSystemTime(Date.now() + 60_000);
    await expect(belaboxModule.resolveTemplateValues?.(["belabox.dropped", "belabox.down_for"], templateContext("en", runModuleAlarm)))
      .resolves.toEqual({ "belabox.dropped": "5", "belabox.down_for": "1 minute" });
    expect(runModuleAlarm).toHaveBeenCalledTimes(2);
    expect(runModuleAlarm).toHaveBeenNthCalledWith(1, "belabox", "poll", "poll", { reason: "on_demand" });
  });

  it("sanitizes on-demand secret and fetch failures", async () => {
    await insertModule("on_demand", 15);
    const failureRoutine = vi.fn(() => Promise.reject(new Error(STATS_URL)));
    const fetchFailure = await belaboxModule.resolveTemplateValues?.(["belabox.status"], templateContext("en", failureRoutine))
      .catch((error: unknown) => error);
    expect(String(fetchFailure)).toContain("BELABOX_SAMPLE_UNAVAILABLE");
    expect(String(fetchFailure)).not.toContain(SECRET_KEY);
    expect(failureRoutine).toHaveBeenCalledWith("belabox", "poll", "poll", { reason: "on_demand" });
  });

  it("returns inactive for an unclassified probe before the first connection", async () => {
    await insertModule();
    await insertStatus(sample("2026-10-06T12:00:20.000Z", {
      connected: false,
      bitrateKbps: 0,
      rttMs: 0,
      latencyMs: 0,
      network: 0,
      droppedPackets: 0,
      droppedTotal: 0,
      phase: "inactive",
    }), null, null);

    await expect(belaboxModule.resolveTemplateValues?.(["belabox.connected", "belabox.status"], templateContext("en")))
      .resolves.toEqual({ "belabox.connected": "disconnected", "belabox.status": "inactive" });
  });

  it("formats the default low phase and keeps the current episode duration", async () => {
    await insertModule();
    await insertStatus(sample("2026-10-06T12:00:20.000Z", {
      bitrateKbps: 999,
      phase: "low",
      alertStartedAt: "2026-10-06T11:59:00.000Z",
    }));

    await expect(belaboxModule.resolveTemplateValues?.(["belabox.status", "belabox.down_for"], templateContext("en")))
      .resolves.toEqual({ "belabox.status": "low bitrate", "belabox.down_for": "1 minute" });
  });

  it("uses the configured low threshold for template health, duration, and overlay bootstrap", async () => {
    await insertModule("interval", 15, 2_000);
    await insertStatus(sample("2026-10-06T12:00:20.000Z", {
      bitrateKbps: 1_500,
      phase: undefined,
      alertStartedAt: "2026-10-06T12:00:00.000Z",
    }));

    await expect(belaboxModule.resolveTemplateValues?.(["belabox.status", "belabox.down_for"], templateContext("en")))
      .resolves.toEqual({ "belabox.status": "low bitrate", "belabox.down_for": "30 seconds" });
    const element = belaboxModule.overlayElements?.find(({ kind }) => kind === "belabox.status");
    const initial = await element?.initialState?.(database as unknown as D1Database, CHANNEL_ID, element.defaultConfig);
    expect(initial).toMatchObject({
      streamSessionKey: "stream:stream-322",
      sample: { bitrateKbps: 1_500, phase: "low", alertStartedAt: "2026-10-06T12:00:00.000Z" },
    });
  });

  it("exposes overlay availability until sampledAt plus max(interval, 30 seconds)", async () => {
    await insertModule("interval", 15);
    await insertStatus(sample("2026-10-06T12:00:20.000Z"));

    await expect(belaboxModule.resolveOverlayTemplateValues?.(["belabox.status"], {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      now: Date.now(),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      language: "en",
    })).resolves.toEqual({
      "belabox.status": { available: true, nextChangeAt: "2026-10-06T12:00:50.000Z" },
    });
  });

  it("schedules on-demand text refreshes while there is no saved sample", async () => {
    await insertModule("on_demand", 60);

    await expect(belaboxModule.resolveOverlayTemplateValues?.(["belabox.status"], {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      now: Date.now(),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      language: "en",
    })).resolves.toEqual({
      "belabox.status": { available: false, nextChangeAt: "2026-10-06T12:01:30.000Z" },
    });
    expect(await database.prepare("SELECT sample_json FROM belabox_status WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toBeNull();
  });

  it("declares a closed lazy status element contract", () => {
    const element = belaboxModule.overlayElements?.find(({ kind }) => kind === "belabox.status");
    expect(element).toMatchObject({
      kind: "belabox.status",
      configVersion: 1,
      defaultSize: { width: 320, height: 40 },
      defaultConfig: { layout: "compact", unit: "kbps", hideWhenHealthy: false },
      mergeRealtimeStateOnModuleMessages: ["modul.belabox.sample"],
      reloadStateOnHostEvents: ["stream.state.changed"],
    });
    expect(element?.parseConfig({ layout: "detail", unit: "mbps", hideWhenHealthy: true }))
      .toEqual({ layout: "detail", unit: "mbps", hideWhenHealthy: true });
    expect(element?.parseConfig({ layout: "detail", unit: "mbps", hideWhenHealthy: true, html: "unsafe" }))
      .toBeNull();
    expect(element?.parseConfig({ layout: "wide" })).toBeNull();
    expect(element?.load).toBeTypeOf("function");
    expect(element?.editor).toBeTypeOf("function");
    expect(element?.initialState).toBeTypeOf("function");
  });

  it("bootstraps the element from D1 and merges the sample message into that state", async () => {
    await insertModule();
    await insertStatus(sample("2026-10-06T12:00:20.000Z"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const element = belaboxModule.overlayElements?.find(({ kind }) => kind === "belabox.status");

    const initial = await element?.initialState?.(database as unknown as D1Database, CHANNEL_ID, element.defaultConfig);
    expect(initial).toMatchObject({
      intervalSeconds: 15,
      mode: "interval",
      streamSessionKey: "stream:stream-322",
      sample: { bitrateKbps: 4_520, phase: "healthy" },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(moduleOverlayElementKindForMessage("modul.belabox.sample")).toBe("belabox.status");
    expect(mergeModuleOverlayElementState("belabox.status", initial ?? null, {
      at: "2026-10-06T12:00:29.000Z",
      connected: false,
      bitrateKbps: 0,
      rttMs: 0,
      phase: "disconnected",
      streamSessionKey: "stream:stream-322",
    })).toMatchObject({
      intervalSeconds: 15,
      sample: { at: "2026-10-06T12:00:29.000Z", phase: "disconnected" },
    });
  });

  it("rejects another session and older realtime sample messages", () => {
    const current = {
      intervalSeconds: 15,
      streamSessionKey: "stream:stream-s1",
      sample: { at: "2026-10-06T12:00:29.000Z", connected: true, bitrateKbps: 4_520, rttMs: 38, phase: "healthy" },
    };
    expect(mergeModuleOverlayElementState("belabox.status", current, {
      at: "2026-10-06T12:00:30.000Z",
      connected: false,
      bitrateKbps: 0,
      rttMs: 0,
      phase: "disconnected",
      streamSessionKey: "stream:stream-s2",
    })).toEqual(current);
    expect(mergeModuleOverlayElementState("belabox.status", current, {
      at: "2026-10-06T12:00:20.000Z",
      connected: false,
      bitrateKbps: 0,
      rttMs: 0,
      phase: "disconnected",
      streamSessionKey: "stream:stream-s1",
    })).toEqual(current);
  });

  it("keeps overlay refresh times in the future and schedules the availability boundary first", async () => {
    await insertModule("interval", 30);
    await insertStatus(sample("2026-10-06T12:00:00.000Z"));

    await expect(belaboxModule.resolveOverlayTemplateValues?.(["belabox.status"], {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      now: Date.parse("2026-10-06T12:00:45.000Z"),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      language: "en",
    })).resolves.toEqual({
      "belabox.status": { available: true, nextChangeAt: "2026-10-06T12:01:15.000Z" },
    });

    await expect(belaboxModule.resolveOverlayTemplateValues?.(["belabox.status"], {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      now: Date.parse("2026-10-06T12:01:29.000Z"),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      language: "en",
    })).resolves.toEqual({
      "belabox.status": { available: true, nextChangeAt: "2026-10-06T12:01:30.001Z" },
    });
  });

  it("renders stale data and inactive hiding in the channel language", () => {
    const base = {
      config: { layout: "detail", unit: "mbps", hideWhenHealthy: false },
      now: Date.parse("2026-10-06T12:01:00.001Z"),
      language: "de" as const,
    };
    const { rerender } = render(createElement(BelaboxStatus, {
      ...base,
      state: {
        sample: { at: "2026-10-06T12:00:15.000Z", connected: true, bitrateKbps: 4_520, rttMs: 38, phase: "healthy" },
        intervalSeconds: 15,
      },
    }));
    expect(screen.getByText("keine Daten")).toBeInTheDocument();

    rerender(createElement(BelaboxStatus, {
      ...base,
      config: { layout: "compact", unit: "kbps", hideWhenHealthy: true },
      now: Date.parse("2026-10-06T12:00:30.000Z"),
      state: {
        sample: { at: "2026-10-06T12:00:20.000Z", connected: false, bitrateKbps: 0, rttMs: 0, phase: "inactive" },
        intervalSeconds: 15,
      },
    }));
    expect(document.querySelector(".belabox-status")).toBeNull();
  });

  it("switches to no data at the stale boundary without a parent rerender", () => {
    render(createElement(BelaboxStatus, {
      config: { layout: "compact", unit: "kbps", hideWhenHealthy: false },
      now: Date.now(),
      language: "en",
      state: {
        sample: { at: "2026-10-06T12:00:20.000Z", connected: true, bitrateKbps: 4_520, rttMs: 38, phase: "healthy" },
        intervalSeconds: 15,
      },
    }));
    expect(screen.getByText("healthy · 4,520 kbps")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(35_001); });

    expect(screen.getByText("no data")).toBeInTheDocument();
  });

  it("explains on-demand updates in the localized editor", () => {
    const onChange = vi.fn();
    render(createElement(BelaboxEditor, {
      config: { layout: "compact", unit: "kbps", hideWhenHealthy: false },
      onChange,
      language: "en",
    }));

    expect(screen.getByText("In on-demand mode, this element does not update live.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "detail" } });
    expect(onChange).toHaveBeenCalledWith({ layout: "detail", unit: "kbps", hideWhenHealthy: false });
  });
});
