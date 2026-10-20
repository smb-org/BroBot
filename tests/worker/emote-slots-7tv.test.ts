import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { emoteSlotsRoutes, clearEmoteSlotEmoteCache } from "../../src/modules/emote_slots/routes";
import { fetchSevenTvEmotes } from "../../src/modules/emote_slots/seven-tv";

const app = new Hono<ModuleRouteEnvironment>();
let successfulTwitchCredentials = false;
app.use("*", async (context, next) => {
  context.set("botCredentials", () => Promise.resolve(successfulTwitchCredentials
    ? { userId: "fictional-broadcaster", accessToken: "fictional-token", scopes: ["user:read:emotes"] }
    : null));
  context.set("getAppAccessToken", () => Promise.resolve("app-token"));
  context.set("getGlobalEmotes", () => Promise.resolve({ ok: true, status: 200, data: [] }));
  context.set("getUserEmotes", () => Promise.resolve({ ok: true, status: 200, data: [] }));
  await next();
});
app.route("/api/channels/:channelId/modules/emote_slots", emoteSlotsRoutes);

const requestEmotes = () => app.request("/api/channels/123456/modules/emote_slots/emotes", {}, {
  TWITCH_CLIENT_ID: "fictional-client-id",
});

const parseJsonUnknown = (text: string): unknown => JSON.parse(text) as unknown;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasEmojiItems = (value: unknown): boolean => isRecord(value) && isRecord(value.emoji) && Array.isArray(value.emoji.items);

afterEach(() => {
  clearEmoteSlotEmoteCache();
  successfulTwitchCredentials = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("emote slot 7TV route", () => {
  it("returns the channel active set and keeps the picker route available (protects=the emote route returns the active 7TV set name and its selectable emotes alongside the existing groups; fails_when=the route omits 7TV data, returns non-active emotes, or fails despite a valid 7TV response; no_claim=the real provider's uptime or all possible 7TV response fields)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({
      emote_set: {
        id: "set-active",
        name: "Night Shift",
        emotes: [{ id: "emote-active", name: "pixelwave" }],
      },
      emotes: [{ id: "emote-user", name: "not-active" }],
    }))));

    const response = await requestEmotes();
    expect(response.status).toBe(200);
    const body = parseJsonUnknown(await response.text());
    expect(body).toMatchObject({
      sevenTv: {
        status: "ok",
        setName: "Night Shift",
        items: [{ source: "seven_tv", code: "pixelwave", sevenTvId: "emote-active" }],
      },
      twitch: { status: "reconnect_required", items: [] },
    });
    expect(hasEmojiItems(body)).toBe(true);
  });

  it("reports no account without adding selectable 7TV emotes (protects=no-account channels receive an explicit empty 7TV group; fails_when=the route returns active items or treats a 404 as a failed emote request; no_claim=the Twitch reconnect state)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));

    const response = await requestEmotes();
    expect(response.status).toBe(200);
    const body = parseJsonUnknown(await response.text());
    expect(body).toMatchObject({
      sevenTv: { status: "no_account", setName: null, items: [] },
      twitch: { status: "reconnect_required", items: [] },
    });
    expect(hasEmojiItems(body)).toBe(true);
  });

  it("turns a 7TV timeout into an unavailable group without failing the emote route (protects=7TV timeout is isolated from emoji and Twitch route data; fails_when=the request rejects, the route returns a non-200 response, or the status is mistaken for no account; no_claim=network timeout duration in production)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new DOMException("The operation timed out", "TimeoutError"))));

    const response = await requestEmotes();
    expect(response.status).toBe(200);
    const body = parseJsonUnknown(await response.text());
    expect(body).toMatchObject({
      sevenTv: { status: "unavailable", setName: null, items: [] },
      twitch: { status: "reconnect_required", items: [] },
    });
    expect(hasEmojiItems(body)).toBe(true);
  });

  it("keeps provider results on their original independent expiries (protects=an expired 7TV result refreshes while a valid Twitch result remains cached; fails_when=the route extends a cached 7TV result past its original ten-minute expiry; no_claim=live provider freshness outside the configured cache lifetime)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    successfulTwitchCredentials = true;
    const providerFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ emote_set: { id: "set-night", name: "Night Shift", emotes: [] } }))
      .mockResolvedValueOnce(Response.json({ emote_set: { id: "set-morning", name: "Morning Shift", emotes: [] } }));
    vi.stubGlobal("fetch", providerFetch);

    await fetchSevenTvEmotes("123456", providerFetch);
    vi.setSystemTime(new Date("2030-01-01T00:09:00.000Z"));
    const pickerResponse = await requestEmotes();
    expect(parseJsonUnknown(await pickerResponse.text())).toMatchObject({ sevenTv: { setName: "Night Shift" } });
    expect(providerFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2030-01-01T00:11:00.000Z"));
    const refreshedResponse = await requestEmotes();
    expect(parseJsonUnknown(await refreshedResponse.text())).toMatchObject({
      twitch: { status: "ok" },
      sevenTv: { status: "ok", setName: "Morning Shift" },
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });
});
