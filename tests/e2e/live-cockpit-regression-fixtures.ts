import type { Page, Route } from "@playwright/test";

const json = (value: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });

export interface LiveCockpitMockOptions {
  channelId: string;
  modules?: readonly { id: string; enabled: boolean; settings: string }[];
  role?: "broadcaster" | "manager" | "operator";
  channelBotConsent?: "granted" | "missing";
  broadcasterMissingScopes?: readonly string[];
  viewerUserId?: string;
  streamState?: "online" | "offline" | null;
  botStatus?: "connected" | "disconnected";
  channelBotStatus?: "connected" | "disconnected";
  events?: readonly Record<string, unknown>[];
  eventsError?: boolean;
  upcomingAd?: boolean;
  location?: { name: string; latitude: number; longitude: number; timeZone: string } | null;
  viewerCount?: number | null;
  nextViewerCount?: number | null;
  tokens?: { botExpiresAt: string | null; loginStatus: "connected" | "error" | "revoked" | null; loginReason: string | null; loginExpiresAt: string | null };
  vote?: Record<string, unknown> | null;
  votekick?: Record<string, unknown> | null;
  shoutoutFailureReason?: string;
  currentStateError?: boolean;
  belaboxStatus?: { errorCode?: string | null; fetchFailureNotice?: boolean };
  waitForCurrentState?: () => Promise<void>;
  waitForOverlays?: () => Promise<void>;
  onVoteClose?: (pollId: string) => void;
  onVotekickCancel?: (id: string) => void;
}

export interface LiveCockpitMockController {
  currentStateRequestCount: () => number;
  failCurrentState: () => void;
  eventRequestCount: () => number;
  setEventsError: (failed: boolean) => void;
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
  const bot = { status: options.botStatus ?? "connected", reason: null, updatedAt: now };
  const channelBot = { ...bot, status: options.channelBotStatus ?? bot.status };
  const tokens = options.tokens ?? { botExpiresAt: "2099-09-20T08:00:00.000Z", loginStatus: "connected" as const, loginReason: null, loginExpiresAt: "2099-09-20T08:00:00.000Z" };
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
    channelBotConsent: options.channelBotConsent ?? "granted",
    bot: channelBot,
    botPermissions: { missingScopes: [] },
    broadcasterPermissions: { missingScopes: options.broadcasterMissingScopes ?? [] },
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
  let currentStateFailed = false;
  let overviewRequests = 0;
  let eventRequests = 0;
  let eventsFailed = options.eventsError ?? false;

  await page.route("**/api/**", async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const channelPrefix = `/api/channels/${channelId}`;
    if (pathname === "/api/channels") return route.fulfill(json({ channels: [channel], bot, viewerUserId: options.viewerUserId ?? "viewer-live-regression" }));
    if (pathname === `${channelPrefix}/overview`) {
      overviewRequests += 1;
      const viewerCount = overviewRequests < 3 ? options.viewerCount ?? 42 : options.nextViewerCount ?? options.viewerCount ?? 42;
      return route.fulfill(json({ ...channel, tokens, viewerCount, activeModules: modules.filter((module) => module.enabled).map(({ id, settings: moduleSettings }) => ({ moduleId: id, settings: moduleSettings })) }));
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
    if (pathname === `${channelPrefix}/overlays`) {
      await options.waitForOverlays?.();
      return route.fulfill(json({ overlays: [], maximum: 20, elementMaximum: 20 }));
    }
    if (pathname === `${channelPrefix}/events`) {
      eventRequests += 1;
      if (eventsFailed) return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
      return route.fulfill(json({ entries: options.events ?? [], nextCursor: null }));
    }
    if (pathname === `${channelPrefix}/audit-log`) return route.fulfill(json({ entries: [], nextCursor: null }));
    if (pathname === `${channelPrefix}/modules/chat_voting/current`) {
      currentStateRequests += 1;
      await options.waitForCurrentState?.();
      if (options.currentStateError || currentStateFailed) return route.fulfill(json({ error: "temporarily_unavailable" }, 503));
      const vote = options.vote === undefined ? null : options.vote;
      return route.fulfill(json({ vote, counts: vote === null ? null : [3, 1], revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
    }
    if (pathname === `${channelPrefix}/modules/chat_voting/close` && method === "POST") {
      const body = route.request().postDataJSON() as { pollId?: unknown };
      const pollId = typeof body.pollId === "string" ? body.pollId : "";
      options.onVoteClose?.(pollId);
      if (pollId.length === 0 || pollId !== options.vote?.id) return route.fulfill(json({ error: "chat_voting_poll_changed" }, 409));
      return route.fulfill(json({ closing: true, pollId: "vote-regression" }));
    }
    if (pathname === `${channelPrefix}/modules/votekick/votekicks` && method === "GET") {
      return route.fulfill(json({ running: options.votekick ?? null, votekicks: options.votekick === null ? [] : [options.votekick], now }));
    }
    if (pathname.startsWith(`${channelPrefix}/modules/votekick/votekicks/`) && pathname.endsWith("/cancel") && method === "POST") {
      const requestedId = decodeURIComponent(pathname.split("/").at(-2) ?? "");
      options.onVotekickCancel?.(requestedId);
      if (requestedId !== options.votekick?.id) return route.fulfill(json({ error: "votekick_changed" }, 409));
      return route.fulfill({ status: 204, body: "" });
    }
    if (pathname === `${channelPrefix}/shoutout` && method === "POST" && options.shoutoutFailureReason !== undefined) {
      return route.fulfill(json({ error: "shoutout_send_failed", reason: options.shoutoutFailureReason }, 502));
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
    failCurrentState: () => { currentStateFailed = true; },
    eventRequestCount: () => eventRequests,
    setEventsError: (failed) => { eventsFailed = failed; },
    overviewRequestCount: () => overviewRequests,
    settingsState: () => settings,
  };
};
