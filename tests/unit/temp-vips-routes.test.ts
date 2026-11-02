import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HelixRequest, ModuleRouteEnvironment, ModuleTempVipRouteAccess } from "../../src/modules/contract";
import { tempVipsRoutes } from "../../src/modules/temp_vips/routes";

const channelId = "channel_demo";
const operationId = "01234567-89ab-42cd-8abc-0123456789ab";
const minimumDurationMs = 10 * 60_000;
const fixedNow = "2026-11-01T12:00:00.000Z";
const row = {
  userId: "user_demo",
  login: "pixelpilz",
  displayName: "Pixelpilz",
  expiresAt: "2026-11-08T12:00:00.000Z",
  grantedAt: "2026-11-01T12:00:00.000Z",
  grantedByUserId: "operator_demo",
  grantedByLogin: "helper_demo",
  source: "dashboard" as const,
  classification: "temporary" as const,
  confirmation: "confirmed" as const,
  expiryReminderAt: null,
  removalFailedAt: null,
  removalAttempts: 0,
  removalError: null,
  endReason: null,
};

const createHarness = (role: string = "operator", mode: "observe" | "managed" | "inactive" = "managed") => {
  const access: ModuleTempVipRouteAccess = {
    mode: vi.fn(() => Promise.resolve(mode)),
    list: vi.fn(() => Promise.resolve([row])),
    listExisting: vi.fn(() => Promise.resolve({ ok: true as const, people: [{ userId: "user_demo", login: "pixelpilz", displayName: "Pixelpilz" }] })),
    addObserved: vi.fn(() => Promise.resolve({ status: "observed_added", row })),
    classify: vi.fn(() => Promise.resolve({ status: "classified", row })),
    grant: vi.fn(() => Promise.resolve({ status: "granted", row })),
    extend: vi.fn(() => Promise.resolve({ status: "extended", row })),
    importExisting: vi.fn(() => Promise.resolve({ status: "imported", row })),
    replayImport: vi.fn(() => Promise.resolve(null)),
    end: vi.fn(() => Promise.resolve({ status: "ended" })),
    retryRemovalNow: vi.fn(() => Promise.resolve({ status: "queued" })),
    release: vi.fn(() => Promise.resolve({ status: "released" })),
  };
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", role as "operator");
    context.set("session", { userId: "operator_demo", sessionId: "session_demo", login: "helper_demo" });
    context.set("tempVips", (targetChannelId) => {
      if (targetChannelId !== channelId) throw new Error("unexpected channel");
      return access;
    });
    context.set("measureServerTiming", (_phase, run) => run());
    context.set("getAppAccessToken", () => Promise.resolve("app_token_demo"));
    const helixRequest = (() => Promise.resolve({
      ok: true,
      status: 200,
      data: { data: [{ id: "user_demo", login: "pixelpilz", display_name: "Pixelpilz" }] },
    })) as HelixRequest;
    context.set("helixRequest", helixRequest);
    await next();
  });
  app.route(`/api/channels/:channelId/modules/temp_vips`, tempVipsRoutes);
  const request = (path: string, body?: unknown) => app.request(
    `/api/channels/${channelId}/modules/temp_vips${path}`,
    path === "/existing-vips" ? {} : body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    { DB: { prepare: (query: string) => ({ bind: () => ({ first: () => Promise.resolve(query.includes("time_zone")
      ? { time_zone: "Europe/Berlin" }
      : { settings: JSON.stringify({ defaultDurationDays: 7, maximumDurationDays: 90, announceExpiry: false }) }) }) }) } as unknown as D1Database },
  );
  return { app, access, request };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("temporary VIP routes", () => {
  it.each([
    "/existing-vips",
    "/vips/observed",
    "/vips/user_demo/classify",
    "/vips/grant",
    "/vips/import",
    "/vips/user_demo/extend",
    "/vips/user_demo/end",
    "/vips/user_demo/release",
    "/vips/user_demo/retry",
  ])("rejects %s for a role below operator before reaching Twitch or the queue", async (path) => {
    const harness = createHarness("viewer");

    const response = await harness.request(path, { operationId, login: "pixelpilz", userId: "user_demo", durationMs: 1_000 });

    expect(response.status).toBe(403);
    expect(harness.access.listExisting).not.toHaveBeenCalled();
    expect(harness.access.addObserved).not.toHaveBeenCalled();
    expect(harness.access.classify).not.toHaveBeenCalled();
    expect(harness.access.grant).not.toHaveBeenCalled();
    expect(harness.access.importExisting).not.toHaveBeenCalled();
    expect(harness.access.extend).not.toHaveBeenCalled();
    expect(harness.access.end).not.toHaveBeenCalled();
    expect(harness.access.retryRemovalNow).not.toHaveBeenCalled();
    expect(harness.access.release).not.toHaveBeenCalled();
  });

  it("sends an operator end request through the durable RPC with its operation ID", async () => {
    const harness = createHarness("operator");

    const response = await harness.request("/vips/user_demo/end", { operationId });

    expect(response.status).toBe(200);
    expect(harness.access.end).toHaveBeenCalledWith({ operationId, userId: "user_demo" });
    await expect(response.json()).resolves.toMatchObject({ status: "ended" });
  });

  it("lets an operator add an observed VIP by login without reading the VIP list", async () => {
    const harness = createHarness("operator", "observe");

    const response = await harness.request("/vips/observed", { operationId, login: "@pixelpilz" });

    expect(response.status).toBe(200);
    expect(harness.access.addObserved).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      person: { userId: "user_demo", login: "pixelpilz", displayName: "Pixelpilz" },
    }));
    expect(harness.access.listExisting).not.toHaveBeenCalled();
  });

  it.each(["observe", "managed"] as const)("allows local-only release in %s mode", async (mode) => {
    const harness = createHarness("operator", mode);

    const response = await harness.request("/vips/user_demo/release", { operationId });

    expect(response.status).toBe(200);
    expect(harness.access.release).toHaveBeenCalledWith({ operationId, userId: "user_demo" });
  });

  it("classifies an observed VIP using a channel-local expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    const harness = createHarness("operator", "observe");

    const response = await harness.request("/vips/user_demo/classify", {
      operationId,
      classification: "temporary",
      expiresAtLocal: "2026-11-01T13:10",
    });

    expect(response.status).toBe(200);
    expect(harness.access.classify).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      userId: "user_demo",
      classification: "temporary",
      expiresAt: "2026-11-01T12:10:00.000Z",
    }));
  });

  it("keeps a relative classification request stable when the same operation is retried", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    const harness = createHarness("operator", "observe");
    const body = { operationId, classification: "temporary", durationMs: 24 * 60 * 60_000 };

    expect((await harness.request("/vips/user_demo/classify", body)).status).toBe(200);
    vi.advanceTimersByTime(60_000);
    expect((await harness.request("/vips/user_demo/classify", body)).status).toBe(200);

    expect(harness.access.classify).toHaveBeenNthCalledWith(1, expect.objectContaining({ expiresAt: null, durationMs: body.durationMs }));
    expect(harness.access.classify).toHaveBeenNthCalledWith(2, expect.objectContaining({ expiresAt: null, durationMs: body.durationMs }));
  });

  it("keeps classification available after switching to managed mode", async () => {
    const harness = createHarness("operator", "managed");

    const response = await harness.request("/vips/user_demo/classify", {
      operationId,
      classification: "permanent",
    });

    expect(response.status).toBe(200);
    expect(harness.access.classify).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      userId: "user_demo",
      classification: "permanent",
      expiresAt: null,
    }));
    expect(harness.access.listExisting).not.toHaveBeenCalled();
  });

  it("does not read the Twitch VIP list in observe mode", async () => {
    const harness = createHarness("operator", "observe");

    const response = await harness.request("/existing-vips");

    expect(response.status).toBe(409);
    expect(harness.access.listExisting).not.toHaveBeenCalled();
  });

  it("blocks observed VIP actions when the module is disabled", async () => {
    const harness = createHarness("operator", "inactive");

    const response = await harness.request("/vips/observed", { operationId, login: "pixelpilz" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "temp_vips_module_disabled" });
    expect(harness.access.addObserved).not.toHaveBeenCalled();
  });

  it.each(["grant", "import", "extend"] as const)("enforces the 10-minute minimum at the %s route boundary", async (action) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    const harness = createHarness();
    const path = action === "grant" ? "/vips/grant" : action === "import" ? "/vips/import" : "/vips/user_demo/extend";
    const target = action === "grant" ? { login: "pixelpilz" } : action === "import" ? { userId: "user_demo" } : {};

    for (const durationMs of [0, minimumDurationMs - 1]) {
      const response = await harness.request(path, { operationId, ...target, durationMs });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "temp_vips_duration_invalid" });
    }
    expect(harness.access.grant).not.toHaveBeenCalled();
    expect(harness.access.importExisting).not.toHaveBeenCalled();
    expect(harness.access.extend).not.toHaveBeenCalled();
  });

  it.each(["grant", "import", "extend"] as const)("accepts exactly 10 minutes at the %s route boundary", async (action) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    const harness = createHarness();
    const path = action === "grant" ? "/vips/grant" : action === "import" ? "/vips/import" : "/vips/user_demo/extend";
    const target = action === "grant" ? { login: "pixelpilz" } : action === "import" ? { userId: "user_demo" } : {};

    const response = await harness.request(path, { operationId, ...target, durationMs: minimumDurationMs });

    expect(response.status).toBe(200);
    const method = action === "grant" ? harness.access.grant : action === "import" ? harness.access.importExisting : harness.access.extend;
    expect(method).toHaveBeenCalledWith(expect.objectContaining({ durationMs: minimumDurationMs }));
  });

  it("converts a channel-local expiry on the server and passes the absolute instant to import", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    const harness = createHarness();

    const response = await harness.request("/vips/import", {
      operationId,
      userId: "user_demo",
      expiresAtLocal: "2026-11-01T13:10",
    });

    expect(response.status).toBe(200);
    expect(harness.access.importExisting).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt: "2026-11-01T12:10:00.000Z",
      durationMs: minimumDurationMs,
    }));
  });

  it("replays an accepted exact-minimum absolute import after the deadline enters the minimum window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    const harness = createHarness();
    const replayImport = vi.mocked(harness.access.replayImport);
    replayImport
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "imported", expiresAt: "2026-11-01T12:10:00.000Z" });
    const body = { operationId, userId: "user_demo", expiresAtLocal: "2026-11-01T13:10" };

    expect((await harness.request("/vips/import", body)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = await harness.request("/vips/import", body);

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ status: "imported", expiresAt: "2026-11-01T12:10:00.000Z" });
    expect(harness.access.importExisting).toHaveBeenCalledTimes(1);
    expect(replayImport).toHaveBeenLastCalledWith(operationId, "user_demo", "2026-11-01T12:10:00.000Z");
  });

  it("rejects a skipped daylight-saving time and deadlines outside the allowed range", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    vi.setSystemTime(new Date("2026-03-29T00:00:00.000Z"));
    const skipped = await harness.request("/vips/import", {
      operationId, userId: "user_demo", expiresAtLocal: "2026-03-29T02:30",
    });
    expect(skipped.status).toBe(400);

    vi.setSystemTime(new Date(fixedNow));
    const tooSoon = await harness.request("/vips/import", {
      operationId, userId: "user_demo", expiresAtLocal: "2026-11-01T13:09",
    });
    const tooLate = await harness.request("/vips/import", {
      operationId, userId: "user_demo", expiresAtLocal: "2027-02-01T13:00",
    });
    expect(tooSoon.status).toBe(400);
    expect(tooLate.status).toBe(400);
    expect(harness.access.importExisting).not.toHaveBeenCalled();
  });

  it("routes retry removal to the existing queue operation instead of enqueueing end", async () => {
    const harness = createHarness();

    const response = await harness.request("/vips/user_demo/retry", { operationId });

    expect(response.status).toBe(200);
    expect(harness.access.retryRemovalNow).toHaveBeenCalledWith("user_demo");
    expect(harness.access.end).not.toHaveBeenCalled();
  });
});
