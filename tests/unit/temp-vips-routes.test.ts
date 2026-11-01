import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HelixRequest, ModuleRouteEnvironment, ModuleTempVipRouteAccess } from "../../src/modules/contract";
import { tempVipsRoutes } from "../../src/modules/temp_vips/routes";

const channelId = "channel_demo";
const operationId = "01234567-89ab-42cd-8abc-0123456789ab";
const row = {
  userId: "user_demo",
  login: "pixelpilz",
  displayName: "Pixelpilz",
  expiresAt: "2026-11-08T12:00:00.000Z",
  grantedAt: "2026-11-01T12:00:00.000Z",
  grantedByUserId: "operator_demo",
  grantedByLogin: "helper_demo",
  source: "dashboard" as const,
  removalFailedAt: null,
  removalAttempts: 0,
  removalError: null,
  endReason: null,
};

const createHarness = (role: string = "operator") => {
  const access: ModuleTempVipRouteAccess = {
    list: vi.fn(() => Promise.resolve([row])),
    listExisting: vi.fn(() => Promise.resolve({ ok: true as const, people: [] })),
    grant: vi.fn(() => Promise.resolve({ status: "granted", row })),
    extend: vi.fn(() => Promise.resolve({ status: "extended", row })),
    importExisting: vi.fn(() => Promise.resolve({ status: "imported", row })),
    end: vi.fn(() => Promise.resolve({ status: "ended" })),
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
    { DB: { prepare: () => ({ bind: () => ({ first: () => Promise.resolve({ settings: JSON.stringify({
      defaultDurationDays: 7, maximumDurationDays: 90, announceExpiry: false,
    }) }) }) }) } as unknown as D1Database },
  );
  return { app, access, request };
};

afterEach(() => vi.restoreAllMocks());

describe("temporary VIP routes", () => {
  it.each([
    "/existing-vips",
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
    expect(harness.access.grant).not.toHaveBeenCalled();
    expect(harness.access.importExisting).not.toHaveBeenCalled();
    expect(harness.access.extend).not.toHaveBeenCalled();
    expect(harness.access.end).not.toHaveBeenCalled();
    expect(harness.access.release).not.toHaveBeenCalled();
  });

  it("sends an operator end request through the durable RPC with its operation ID", async () => {
    const harness = createHarness("operator");

    const response = await harness.request("/vips/user_demo/end", { operationId });

    expect(response.status).toBe(200);
    expect(harness.access.end).toHaveBeenCalledWith({ operationId, userId: "user_demo" });
    await expect(response.json()).resolves.toMatchObject({ status: "ended" });
  });
});
