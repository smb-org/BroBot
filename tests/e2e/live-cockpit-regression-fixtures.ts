import type { Page, Route } from "@playwright/test";

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

export interface LiveCockpitMockOptions {
  channelId: string;
  modules?: readonly { id: string; enabled: boolean; settings: string }[];
  role?: "broadcaster" | "manager" | "operator";
  streamState?: "online" | "offline" | null;
  events?: readonly Record<string, unknown>[];
  upcomingAd?: boolean;
  location?: { name: string; latitude: number; longitude: number; timeZone: string } | null;
  viewerCount?: number | null;
  nextViewerCount?: number | null;
  vote?: Record<string, unknown> | null;
  currentStateError?: boolean;
  belaboxStatus?: { errorCode?: string | null; fetchFailureNotice?: boolean };
  waitForCurrentState?: () => Promise<void>;
  onVoteClose?: () => void;
}

export interface LiveCockpitMockController {
  currentStateRequestCount: () => number;
  overviewRequestCount: () => number;
  settingsState: () => {
    timeZone: string;
    revision: number;
    location: LiveCockpitMockOptions["location"];
    locationRevision: number;
    defaultChatTarget: string;
    defaultChatTargetRevision: number;
  };
}

export const installLiveCockpitMocks = async (page: Page, options: LiveCockpitMockOptions): Promise<LiveCockpitMockController> => {
  const modules = options.modules ?? [];
  const channelId = options.channelId;
  const now = new Date().toISOString();
  const bot = { status: "connected", reason: null, updatedAt: now };
  const tokens = { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" };
  const channel = {
    channelId,
    login: "demo-kanal",
    displayName: "Demo Kanal",
    language: "de",
    role: options.role ?? "manager",
    streamState: options.streamState ?? "online",
    streamStartedAt: new Date(Date.now() - 60_000).toISOString(),
    viewerCount: options.viewerCount ?? 42,
    location: options.location ?? null,
    broadcasterConnection: "connected",
    channelBotConsent: "granted",
    bot,
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: [] },
    moderator: { isModerator: true, checkedAt: now, reason: null },
    chatSubscription: { status: "enabled", subscriptionId: "sub-live-regression", reason: null, updatedAt: now },
    chatSubscriptionNeeded: false,
    modules,
    tokens,
    lastError: null,
  };
  let settings = {
    timeZone: "Europe/Berlin",
    revision: 1,
    location: options.location ?? null,
    locationRevision: 0,
    defaultChatTarget: "source_only",
    defaultChatTargetRevision: 1,
  };
  let currentStateRequests = 0;
  let overviewRequests = 0;

  await page.route("**/api/**", async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const channelPrefix = `/api/channels/${channelId}`;
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot, viewerUserId: "viewer-live-regression" }));
    if (pathname === `${channelPrefix}/overview`) {
      overviewRequests += 1;
      const viewerCount = overviewRequests < 3 ? options.viewerCount ?? 42 : options.nextViewerCount ?? options.viewerCount ?? 42;
      return route.fulfill(json({ ...channel, viewerCount, activeModules: modules.filter((module) => module.enabled).map(({ id, settings: moduleSettings }) => ({ moduleId: id, settings: moduleSettings })) }));
    }
    if (pathname === `${channelPrefix}/modules` && method === "GET") return route.fulfill(json({ modules }));
    if (pathname === `${channelPrefix}/settings` && method === "GET") return route.fulfill(json(settings));
    if (pathname === `${channelPrefix}/settings` && method === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (typeof body.timeZone === "string") settings = { ...settings, timeZone: body.timeZone, revision: settings.revision + 1 };
      if (typeof body.defaultChatTarget === "string") settings = { ...settings, defaultChatTarget: body.defaultChatTarget, defaultChatTargetRevision: settings.defaultChatTargetRevision + 1 };
      return route.fulfill(json({ ok: true, ...settings }));
    }
    if (pathname === `${channelPrefix}/settings/location/geocode`) {
      return route.fulfill(json({ results: [{ name: "Berlin", admin1: "Berlin", country: "Deutschland", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" }] }));
    }
    if (pathname === `${channelPrefix}/settings/location` && method === "PATCH") {
      const body = route.request().postDataJSON() as { location: LiveCockpitMockOptions["location"] };
      settings = { ...settings, location: body.location ?? null, locationRevision: settings.locationRevision + 1 };
      return route.fulfill(json({ ok: true, location: settings.location, locationRevision: settings.locationRevision }));
    }
    if (pathname === `${channelPrefix}/system`) {
      return route.fulfill(json({
        broadcasterConnection: channel.broadcasterConnection,
        bot,
        botPermissions: channel.botPermissions,
        broadcasterPermissions: channel.broadcasterPermissions,
        chatSubscription: channel.chatSubscription,
        chatSubscriptionNeeded: false,
        subscriptions: [],
        tokens,
      }));
    }
    if (pathname === `${channelPrefix}/overlays`) return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    if (pathname === `${channelPrefix}/events`) return route.fulfill(json({ entries: options.events ?? [], nextCursor: null }));
    if (pathname === `${channelPrefix}/audit-log`) return route.fulfill(json({ entries: [], nextCursor: null }));
    if (pathname === `${channelPrefix}/modules/chat_voting/current`) {
      currentStateRequests += 1;
      await options.waitForCurrentState?.();
      if (options.currentStateError) return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
      const vote = options.vote === undefined ? null : options.vote;
      return route.fulfill(json({ vote, counts: vote === null ? null : [3, 1], revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
    }
    if (pathname === `${channelPrefix}/modules/chat_voting/close` && method === "POST") {
      options.onVoteClose?.();
      return route.fulfill(json({ closing: true, pollId: "vote-regression" }));
    }
    if (pathname === `${channelPrefix}/clips` && method === "POST") return route.fulfill(json({ clipId: "clip-regression", editUrl: "https://clips.twitch.tv/edit/clip-regression" }));
    if (pathname === "/api/csrf") return route.fulfill(json({ token: "csrf-live-regression" }));
    if (pathname === `${channelPrefix}/modules/belabox/status`) {
      return route.fulfill(json({
        configured: true, updatedAt: now, mode: "stats_url", sample: { connected: true, bitrateKbps: 4_000, at: now },
        errorCode: options.belaboxStatus?.errorCode ?? null, polling: true, pollingDesired: true, streamId: "stream-a",
        belaboxStreamId: "stream-a", alertNotice: null, fetchFailureNotice: options.belaboxStatus?.fetchFailureNotice ?? false,
        intervalSeconds: 5,
      }));
    }
    if (pathname === `${channelPrefix}/modules/ads/schedule`) {
      return route.fulfill(json({
        schedule: {
          nextAdAt: options.upcomingAd ? new Date(Date.now() + 10 * 60_000).toISOString() : null,
          duration: options.upcomingAd ? 60 : null,
          lastAdAt: null,
          prerollFreeTime: null,
          snoozeCount: options.upcomingAd ? 1 : 0,
          snoozeRefreshAt: null,
        },
        snoozeScopeAvailable: true,
        recentAdBreaks: [],
      }));
    }
    if (pathname === `${channelPrefix}/modules/belabox/test` && method === "POST") return route.fulfill(json({ ok: true, connected: false, bitrateKbps: 0 }));
    return route.fulfill(json({}));
  });

  return {
    currentStateRequestCount: () => currentStateRequests,
    overviewRequestCount: () => overviewRequests,
    settingsState: () => settings,
  };
};
