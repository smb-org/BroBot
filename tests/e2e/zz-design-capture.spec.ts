import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type Page, type Route } from "@playwright/test";

type Role = "broadcaster" | "manager" | "operator";
type Mode = "normal" | "empty" | "login-required" | "bot-unavailable";
interface Capture { slug: string; description: string; path: string; role?: Role; mode?: Mode; interact?: (page: Page) => Promise<void> }
interface Shot {
  file: string; description: string; width: number; height: number; role: Role; mode: Mode;
  consoleErrors: string[]; horizontalOverflow: boolean | null; documentWidth: number | null; overflowPixels: number | null; captureError?: string;
}

const OUTPUT_DIR = "/private/tmp/claude-501/-Users-sb-tools-BroBot/1cad8a03-1f71-4060-966c-d4bb551755e6/scratchpad/design-after";
const CHANNEL_PATH = "/api/channels/esembe";
const DASHBOARD_CHANNEL_PATH = "/channels/esembe";
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();
const stringify = (value: unknown): string => JSON.stringify(value);

const settings: Record<string, Record<string, unknown>> = {
  text_commands: {},
  text_library: {},
  channel_events: {},
  ads: { automatic: "Thanks for watching! We’ll be back in {duration} seconds.", manual: "A short break starts now — back in {duration} seconds.", prewarning: true, leadSeconds: 60, prewarningText: "Ad break in {seconds} seconds. See you soon!" },
  raid: { shoutoutEnabled: true, shoutoutThreshold: 5, textThreshold: 3, textLong: "Welcome raiders from {channel}! Thanks for bringing {viewers} people along.", textShort: "Welcome, raiders from {channel}!" },
  clips: {},
};
const moduleStates = () => Object.entries(settings).map(([id, value]) => ({
  id, enabled: true, settings: stringify(value),
  ...(id === "channel_events" || id === "text_library" ? { mandatory: true } : {}),
  ...(id === "ads" ? { requiredBroadcasterScopes: ["channel:read:ads"], missingBroadcasterScopes: [] } : {}),
}));
const state = (role: Role = "broadcaster") => ({
  channelId: "esembe", login: "esembe", displayName: "Esembe", language: "en", role,
  broadcasterConnection: "connected", channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: ago(38) },
  botPermissions: { missingScopes: [] }, broadcasterPermissions: { missingScopes: [] },
  moderator: { isModerator: true, checkedAt: ago(6), reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-chat-esembe", reason: null, updatedAt: ago(31) },
  chatSubscriptionNeeded: true, streamState: "online", streamStartedAt: ago(94), streamStateChangedAt: ago(94), streamStateCheckedAt: ago(1),
  modules: moduleStates(),
  controls: { mute: { active: false, until: null, mode: null }, pause: { active: false, until: null, mode: null } },
  tokens: { botExpiresAt: ahead(186), loginStatus: "connected", loginReason: null, loginExpiresAt: ahead(214) },
  lastError: null,
});
const activeModules = () => Object.entries(settings).map(([moduleId, value]) => ({ moduleId, settings: stringify(value) }));

const members = [
  { userId: "u-esembe", login: "esembe", displayName: "Esembe", profileImageUrl: null, role: "broadcaster", joinedAt: "2023-08-12T10:00:00Z" },
  { userId: "kanal_b", login: "kanal_b", displayName: "Kanal B", profileImageUrl: null, role: "manager", joinedAt: "2024-01-19T12:30:00Z" },
  { userId: "viewer_a", login: "viewer_a", displayName: "Viewer A", profileImageUrl: null, role: "operator", joinedAt: "2024-06-02T09:20:00Z" },
  { userId: "friend_c", login: "friend_c", displayName: "Friend C", profileImageUrl: null, role: "operator", joinedAt: "2025-02-15T16:05:00Z" },
];
const variables = [
  { channelId: "esembe", name: "points", value: 382, description: "Community points earned this season", resetOnStreamStart: true, createdAt: "2025-03-01T12:00:00Z", updatedAt: ago(18), usages: [
    { moduleId: "text_commands", itemName: "!score", kind: "template" },
    { moduleId: "overlays", itemName: "Stream Studio", kind: "display", overlayId: "overlay-studio", elementId: "element-score", elementLabel: "Community score" },
  ] },
  { channelId: "esembe", name: "new_members", value: 12, description: "New community members this month", resetOnStreamStart: false, createdAt: "2025-04-08T12:00:00Z", updatedAt: ago(47), usages: [
    { moduleId: "overlays", itemName: "Stream Studio", kind: "display", overlayId: "overlay-studio", elementId: "element-members", elementLabel: "New supporters" },
  ] },
  { channelId: "esembe", name: "marathons", value: 5, description: "Community marathon sessions completed", resetOnStreamStart: false, createdAt: "2025-05-22T12:00:00Z", updatedAt: ago(143), usages: [{ moduleId: "text_commands", itemName: "!marathon", kind: "action" }] },
  { channelId: "esembe", name: "support_goal", value: 64, description: "Progress toward the monthly support goal", resetOnStreamStart: false, createdAt: "2025-06-17T12:00:00Z", updatedAt: ago(304), usages: [] },
];
const styleCss = [
  "/* brobot:style:begin - managed by the style editor, changes here are overwritten */",
  ".brobot-overlay :where(.brobot-variable, .brobot-module-text) {", "  font-size: 32px;", "  font-weight: 600;", "  color: #ffffff;", "  text-align: center;", "}", "",
  ".brobot-overlay .brobot-overlay-composition-element {", "  --brobot-overlay-anchor-x: -50%;", "}", "",
  '[data-element="element-score"] :where(.brobot-variable, .brobot-module-text) {', "  font-size: 48px;", "  color: #ffcc00;", "}", "",
  '[data-element="element-members"] :where(.brobot-variable, .brobot-module-text) {', "  font-size: 24px;", "  color: #8bd8ff;", "}", "/* brobot:style:end */",
].join("\n");
const overlayStudio = {
  id: "overlay-studio", channelId: "esembe", name: "Stream Studio", width: 1920, height: 1080, css: styleCss, revision: 7,
  createdAt: "2025-02-09T10:15:00Z", updatedAt: ago(42), elements: [
    { id: "element-score", kind: "variable", label: "Community score", variableName: "points", text: "{value} points", config: {}, x: 128, y: 144, scalePercent: 100, z: 1, inComposition: true },
    { id: "element-members", kind: "variable", label: "New supporters", variableName: "new_members", text: "Today · {value}", config: {}, x: 130, y: 226, scalePercent: 100, z: 2, inComposition: true },
  ],
};
const overlayGoals = {
  id: "overlay-goals", channelId: "esembe", name: "Monthly Goal", width: 1280, height: 720, css: "", revision: 3,
  createdAt: "2025-05-18T08:00:00Z", updatedAt: ago(8_640), elements: [
    { id: "element-goal", kind: "variable", label: "Monthly support", variableName: "support_goal", text: "{value} / 100", config: {}, x: 32, y: 40, scalePercent: 100, z: 1, inComposition: true },
  ],
};
const overlaySummaries = [overlayStudio, overlayGoals].map((overlay, index) => ({
  id: overlay.id, name: overlay.name, width: overlay.width, height: overlay.height, revision: overlay.revision,
  elementCount: overlay.elements.length, accessCount: index === 0 ? 1 : 0, lastUsedAt: index === 0 ? ago(34) : null,
  createdAt: overlay.createdAt, updatedAt: overlay.updatedAt,
}));
const accesses = [{ tokenId: "access-obs-studio", overlayId: "overlay-studio", label: "OBS Studio", createdAt: "2025-06-11T14:30:00Z", expiresAt: null, revokedAt: null, lastUsedAt: ago(34), recoverable: true }];

const commands = [
  { channelId: "esembe", name: "hello", text: "Welcome in, {user}! Make yourself at home.", kind: "text", enabled: true, minimumTier: "everyone", cooldownSeconds: 5, aliases: ["hi"], userCooldownSeconds: 0, streamCondition: "any", responseType: "say", variableAction: null, useCount: 1240, lastUsedAt: ago(3), createdAt: "2025-01-14T11:00:00Z", updatedAt: ago(29), revision: 4 },
  { channelId: "esembe", name: "score", text: "Our community has {var.points} points so far.", kind: "text", enabled: true, minimumTier: "everyone", cooldownSeconds: 8, aliases: ["points"], userCooldownSeconds: 0, streamCondition: "any", responseType: "reply", variableAction: null, useCount: 832, lastUsedAt: ago(16), createdAt: "2025-02-21T10:00:00Z", updatedAt: ago(83), revision: 9 },
  { channelId: "esembe", name: "marathon", text: "Added one marathon session — total: {var.marathons}.", kind: "text", enabled: true, minimumTier: "subscriber", cooldownSeconds: 30, aliases: [], userCooldownSeconds: 60, streamCondition: "online", responseType: "say", variableAction: { name: "marathons", operation: "add", amount: 1 }, useCount: 46, lastUsedAt: ago(182), createdAt: "2025-04-09T15:00:00Z", updatedAt: ago(326), revision: 2 },
];
const textLibraryBlocks = [
  {
    channelId: "esembe", name: "welcome", categoryId: "social", games: [],
    variants: [{ id: "live", conditions: { stream: "online" }, texts: ["Welcome to the stream, {user}!"] }, { id: "default", conditions: {}, texts: ["Welcome, {user}!"] }],
    revision: 4, createdAt: "2025-01-15T11:00:00Z", updatedAt: ago(24),
  },
  {
    channelId: "esembe", name: "chat_rules", categoryId: "info", games: [],
    variants: [{ id: "default", conditions: {}, texts: ["Be kind, keep it welcoming, and have fun."] }],
    revision: 2, createdAt: "2025-02-18T10:00:00Z", updatedAt: ago(72),
  },
  {
    channelId: "esembe", name: "game_opening", categoryId: "game", games: [{ id: "32982", name: "Grand Theft Auto V" }],
    variants: [
      { id: "live", conditions: { stream: "online", game: { mode: "is", game: { id: "32982", name: "Grand Theft Auto V" } } }, texts: ["We are live in {game}!"] },
      { id: "default", conditions: {}, texts: ["Next up: {game}."] },
    ],
    revision: 1, createdAt: "2025-04-22T15:00:00Z", updatedAt: ago(11),
  },
];
const textLibraryCategories = [
  { id: "social", catalogKey: "social", customName: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: ago(120) },
  { id: "info", catalogKey: "info", customName: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: ago(120) },
  { id: "game", catalogKey: "game", customName: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: ago(120) },
];
const textLibraryData = () => ({
  blocks: textLibraryBlocks,
  categories: textLibraryCategories,
  settings: { timeZone: "Europe/Berlin", revision: 3, graphRevision: 8, updatedAt: ago(18) },
  usages: {
    welcome: [{ kind: "command", label: "!hello" }, { kind: "event", label: "First chatter" }],
    chat_rules: [{ kind: "command", label: "!rules" }],
    game_opening: [{ kind: "command", label: "!game" }],
  },
  reservedNames: ["user", "channel", "game"],
});
const events = [
  { eventId: "evt-raid-01", createdAt: ago(6), moduleId: "channel_events", triggerId: "raid-trigger-01", code: "channel_events.raid.incoming", detail: stringify({ source: "streamer_k", viewers: 126 }), actorUserId: "streamer_k_id", actorLogin: "streamer_k", actorDisplayName: "Streamer K" },
  { eventId: "evt-raid-shoutout", createdAt: ago(6), moduleId: "raid", triggerId: "raid-trigger-01", code: "raid.shoutout", detail: stringify({ channel: "streamer_k", viewers: 126, threshold: 5 }), actorUserId: null, actorLogin: null, actorDisplayName: null },
  { eventId: "evt-command-score", createdAt: ago(13), moduleId: "text_commands", triggerId: "command-trigger-score", code: "text_commands.triggered", detail: stringify({ name: "score" }), actorUserId: "viewer_a", actorLogin: "viewer_a", actorDisplayName: "Viewer A" },
  { eventId: "evt-ad-break", createdAt: ago(37), moduleId: "ads", triggerId: "ad-trigger-01", code: "ads.announcement", detail: stringify({ automatic: true, duration: 90 }), actorUserId: null, actorLogin: null, actorDisplayName: null },
  { eventId: "evt-gift", createdAt: ago(52), moduleId: "channel_events", triggerId: "gift-trigger-01", code: "channel_events.chat.community_gift", detail: stringify({ gifter: "viewer_a", count: 5 }), actorUserId: "viewer_a", actorLogin: "viewer_a", actorDisplayName: "Viewer A" },
  { eventId: "evt-warning", createdAt: ago(74), moduleId: "raid", triggerId: "warning-trigger-01", code: "shoutout.suppressed", detail: stringify({ reason: "below_threshold", viewers: 2, threshold: 5 }), actorUserId: null, actorLogin: null, actorDisplayName: null },
];
const auditEntries = [
  { auditId: "audit-ads", actorUserId: "kanal_b", actorLogin: "kanal_b", actorDisplayName: "Kanal B", actorKind: "member", createdAt: ago(41), moduleId: "ads", action: "ads.settings_changed",
    before: stringify({ channelId: "esembe", moduleId: "ads", settings: stringify({ ...settings.ads, leadSeconds: 45 }) }),
    after: stringify({ channelId: "esembe", moduleId: "ads", settings: stringify(settings.ads) }) },
  { auditId: "audit-role", actorUserId: "u-esembe", actorLogin: "esembe", actorDisplayName: "Esembe", actorKind: "member", createdAt: ago(96), moduleId: null, action: "member.role_changed",
    before: stringify({ userId: "friend_c", role: "operator" }), after: stringify({ userId: "friend_c", role: "manager" }), subjectUserId: "friend_c", subjectLogin: "friend_c", subjectDisplayName: "Friend C" },
  { auditId: "audit-variable", actorUserId: "kanal_b", actorLogin: "kanal_b", actorDisplayName: "Kanal B", actorKind: "member", createdAt: ago(192), moduleId: null, action: "channel.variable.created",
    before: stringify({}), after: stringify({ name: "support_goal", value: 64, description: "Progress toward the monthly support goal" }) },
  { auditId: "audit-overlay", actorUserId: "u-esembe", actorLogin: "esembe", actorDisplayName: "Esembe", actorKind: "member", createdAt: ago(1_420), moduleId: null, action: "overlay.created",
    before: stringify({}), after: stringify({ name: "Stream Studio", width: 1920, height: 1080, revision: 1 }) },
];
const subscriptions = ["stream.online", "stream.offline", "channel.raid", "channel.shoutout.create", "channel.shoutout.receive", "channel.chat.notification", "channel.moderate", "channel.ad_break.begin"].map((subscriptionType, i) => ({
  subscriptionType, variant: "default", version: "1", subscriptionId: "eventsub-" + String(i + 1), status: "enabled", reason: null, message: null, statusCode: null, updatedAt: ago(i * 7 + 22),
}));
const platformChannels = [
  { channelId: "esembe", login: "esembe", displayName: "Esembe", fullConsent: true, memberCounts: { broadcaster: 1, manager: 1, operator: 2 }, broadcasterConnected: true },
  { channelId: "kanal_b", login: "kanal_b", displayName: "Kanal B", fullConsent: false, memberCounts: { broadcaster: 1, manager: 2, operator: 1 }, broadcasterConnected: false },
];
const platformAudit = [
  { auditId: "platform-release", actorUserId: "admin-fictional", actorLogin: "admin_fictional", actorDisplayName: "Admin Fictional", actorKind: "platform_admin", createdAt: ago(240), channelId: "esembe", moduleId: null, action: "channel.released", before: stringify({}), after: stringify({ login: "esembe" }) },
  { auditId: "platform-role", actorUserId: "admin-fictional", actorLogin: "admin_fictional", actorDisplayName: "Admin Fictional", actorKind: "platform_admin", createdAt: ago(1_140), channelId: "esembe", moduleId: null, action: "member.role_changed", before: stringify({ userId: "viewer_a", role: "manager" }), after: stringify({ userId: "viewer_a", role: "operator" }) },
];
const system = () => ({
  broadcasterConnection: "connected", bot: { status: "connected", reason: null, updatedAt: ago(38) },
  botPermissions: { missingScopes: [] }, broadcasterPermissions: { missingScopes: [] },
  chatSubscription: { status: "enabled", subscriptionId: "sub-chat-esembe", reason: null, updatedAt: ago(31) },
  chatSubscriptionNeeded: true, subscriptions, tokens: { botExpiresAt: ahead(186), loginStatus: "connected", loginReason: null, loginExpiresAt: ahead(214) },
});

const respond = (route: Route, body: unknown, status = 200): Promise<void> => route.fulfill({
  status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: stringify(body),
});

async function installMocks(page: Page, role: Role, mode: Mode): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US", "en"] });
  });
  await page.routeWebSocket("**/ws/channels/**", (socket) => {
    socket.send(stringify({ version: 1, id: "capture-system-hello", createdAt: new Date().toISOString(), channelId: "esembe", type: "system.hello", payload: {} }));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/csrf") return respond(route, { token: "design-capture-csrf" });
    if (path === "/api/channels") {
      if (mode === "login-required") return respond(route, { error: "session_invalid" }, 401);
      const bot = mode === "bot-unavailable" ? { status: "revoked", reason: "token_revoked", updatedAt: ago(80) } : { status: "connected", reason: null, updatedAt: ago(38) };
      return respond(route, { channels: mode === "empty" ? [] : [state(role)], bot, platformAdmin: true, viewerIsBot: false, botLogin: "brobot_helper" });
    }
    if (path === "/api/platform") return respond(route, { channels: platformChannels });
    if (path === "/api/platform/audit") return respond(route, { entries: platformAudit, nextCursor: null });
    if (path === "/api/platform/channels/esembe/members" || path === "/api/platform/channels/kanal_b/members") {
      return respond(route, { members, nextCursor: null, broadcasterCount: 1, viewerUserId: "admin-fictional" });
    }
    if (path === CHANNEL_PATH + "/overview") return respond(route, { ...state(role), activeModules: activeModules() });
    if (path === CHANNEL_PATH + "/system") return respond(route, system());
    if (path === CHANNEL_PATH + "/members") return respond(route, { members, nextCursor: null, broadcasterCount: 1, viewerUserId: role === "operator" ? "viewer_a" : role === "manager" ? "kanal_b" : "u-esembe" });
    if (path === CHANNEL_PATH + "/events") return respond(route, { entries: events, nextCursor: null });
    if (path === CHANNEL_PATH + "/audit-log") return respond(route, { entries: auditEntries, nextCursor: null });
    if (path === CHANNEL_PATH + "/modules") return respond(route, { modules: moduleStates() });
    if (path === CHANNEL_PATH + "/variables") return respond(route, { variables, count: variables.length, maximum: 50 });
    if (path === CHANNEL_PATH + "/overlay-tokens") return respond(route, { tokens: [], nextOffset: null });
    if (path === CHANNEL_PATH + "/overlays") return respond(route, { overlays: overlaySummaries, maximum: 20, elementMaximum: 20 });
    if (path === CHANNEL_PATH + "/overlays/overlay-studio") return respond(route, { overlay: overlayStudio });
    if (path === CHANNEL_PATH + "/overlays/overlay-goals") return respond(route, { overlay: overlayGoals });
    if (path === CHANNEL_PATH + "/overlays/overlay-studio/accesses") return respond(route, { accesses, activeCount: 1, maximum: 5 });
    if (path === CHANNEL_PATH + "/overlays/overlay-goals/accesses") return respond(route, { accesses: [], activeCount: 0, maximum: 5 });
    if (path === CHANNEL_PATH + "/modules/text_commands/commands") {
      return respond(route, { commands, variables: variables.map(({ name, value, description }) => ({ name, value, description })) });
    }
    if (path === CHANNEL_PATH + "/modules/text_library/library") return respond(route, textLibraryData());
    if (path === CHANNEL_PATH + "/modules/text_library/blocks") return respond(route, { blocks: textLibraryBlocks.map(({ name }) => ({ name })) });
    if (path === CHANNEL_PATH + "/modules/text_library/games") return respond(route, { games: [{ id: "32982", name: "Grand Theft Auto V" }] });
    if (path.startsWith(CHANNEL_PATH + "/modules/text_commands/commands/")) {
      const name = decodeURIComponent(path.split("/").at(-1) ?? "");
      return respond(route, { command: commands.find((command) => command.name === name) ?? commands[0] });
    }
    if (path === CHANNEL_PATH + "/modules/ads/schedule") {
      return respond(route, {
        schedule: { nextAdAt: ahead(1_080), duration: 90, lastAdAt: ago(47), prerollFreeTime: 1_460, snoozeCount: 2, snoozeRefreshAt: ahead(1_380) },
        recentAdBreaks: [{ timestamp: ago(47), durationSeconds: 90 }, { timestamp: ago(112), durationSeconds: 60 }],
        snoozeScopeAvailable: true, asOf: ago(2),
      });
    }
    if (path.startsWith(CHANNEL_PATH + "/modules/") && path.endsWith("/settings")) {
      const id = decodeURIComponent(path.split("/").at(-2) ?? "");
      return respond(route, { settings: settings[id] ?? {}, revision: 6, variables });
    }
    if (path.startsWith(CHANNEL_PATH + "/")) {
      if (method === "DELETE") return route.fulfill({ status: 204 });
      return respond(route, { warnings: [], closingPending: false });
    }
    return respond(route, {});
  });
}

const captures: Capture[] = [
  { slug: "home-channels", description: "Installation home with the released channel list", path: "/" },
  { slug: "overview", description: "Live channel overview with operations and recent activity", path: "/channels/esembe" },
  { slug: "events-list", description: "Event log with channel and module diagnostics", path: DASHBOARD_CHANNEL_PATH + "/events" },
  { slug: "events-selected", description: "Event log with raid event history inspector open", path: DASHBOARD_CHANNEL_PATH + "/events", interact: async (p) => { await p.locator("table.event-table tbody tr").first().click(); } },
  { slug: "system", description: "Channel system state, identities, permissions, and EventSub subscriptions", path: DASHBOARD_CHANNEL_PATH + "/system" },
  { slug: "members-list", description: "Channel members across broadcaster, manager, and operator roles", path: DASHBOARD_CHANNEL_PATH + "/members" },
  { slug: "members-selected", description: "Selected Viewer A member inspector", path: DASHBOARD_CHANNEL_PATH + "/members", interact: async (p) => { await p.locator("table.members-table tbody tr").filter({ hasText: "Viewer A" }).click(); } },
  { slug: "variables-list", description: "Channel variable list with four counters and usage metadata", path: DASHBOARD_CHANNEL_PATH + "/variables" },
  { slug: "variables-detail", description: "Points variable inspector with linked command and overlay usage", path: DASHBOARD_CHANNEL_PATH + "/variables", interact: async (p) => { await p.locator("table.channel-variables-table tbody tr").filter({ hasText: "points" }).click(); } },
  { slug: "overlays-list", description: "Overlay list with composition sizes and access counts", path: DASHBOARD_CHANNEL_PATH + "/overlays" },
  { slug: "overlays-setup", description: "Stream Studio inspector with OBS setup assistant open", path: DASHBOARD_CHANNEL_PATH + "/overlays?overlay=overlay-studio", interact: async (p) => { await p.getByRole("button", { name: /^set up$/i }).click(); } },
  { slug: "overlay-editor-position", description: "Stream Studio editor with selected element position properties", path: DASHBOARD_CHANNEL_PATH + "/overlays/overlay-studio" },
  { slug: "overlay-editor-style", description: "Stream Studio editor with style controls selected", path: DASHBOARD_CHANNEL_PATH + "/overlays/overlay-studio", interact: async (p) => { await p.getByRole("tab", { name: /style/i }).click(); } },
  { slug: "audit-list", description: "Audit log with module, member, variable, and overlay changes", path: DASHBOARD_CHANNEL_PATH + "/audit" },
  { slug: "audit-selected", description: "Selected ad settings change with before and after diff", path: DASHBOARD_CHANNEL_PATH + "/audit", interact: async (p) => { await p.locator(".audit-sentence-row").first().click(); } },
  { slug: "modules-list", description: "Enabled module list including mandatory channel events", path: DASHBOARD_CHANNEL_PATH + "/modules" },
  { slug: "module-text-commands", description: "Text commands list with one command editor open", path: DASHBOARD_CHANNEL_PATH + "/modules/text_commands", interact: async (p) => { await p.locator("section.command-list table tbody tr").first().click(); } },
  { slug: "module-text-commands-advanced", description: "Text command availability inspector with the stream and game filters", path: DASHBOARD_CHANNEL_PATH + "/modules/text_commands", interact: async (p) => {
    await p.locator("section.command-list table tbody tr").first().click();
    await p.getByRole("tab", { name: "Advanced" }).click();
    await p.getByRole("searchbox", { name: "Twitch games" }).waitFor({ state: "visible" });
  } },
  { slug: "module-raid", description: "Raid settings and enabled shoutout configuration", path: DASHBOARD_CHANNEL_PATH + "/modules/raid" },
  { slug: "module-ads", description: "Ads schedule, recent breaks, and automatic message settings", path: DASHBOARD_CHANNEL_PATH + "/modules/ads" },
  { slug: "module-channel-events", description: "Mandatory channel events module detail page", path: DASHBOARD_CHANNEL_PATH + "/modules/channel_events" },
  { slug: "module-clips", description: "Clips module detail page with its enabled state", path: DASHBOARD_CHANNEL_PATH + "/modules/clips" },
  { slug: "platform-operators", description: "Platform channel inspector with operators and audit rows", path: "/platform", interact: async (p) => { await p.locator("table.platform-channel-table tbody tr").filter({ hasText: "esembe" }).click(); } },
  { slug: "spotlight", description: "Dashboard Spotlight opened with Cmd+K", path: "/channels/esembe", interact: async (p) => {
    await p.keyboard.press("Meta+k");
    const dialog = p.getByRole("dialog");
    if (!(await dialog.isVisible().catch(() => false))) await p.keyboard.press("Control+k");
    await dialog.waitFor({ state: "visible" });
  } },
  { slug: "login-required", description: "Sign-in required screen after mocked session expiry", path: "/", mode: "login-required" },
  { slug: "empty-home", description: "Installation home with no released channels", path: "/", mode: "empty" },
  { slug: "bot-sign-in-needed", description: "Channel route blocked while installation bot identity is revoked", path: "/channels/esembe", mode: "bot-unavailable" },
  { slug: "operator-text-commands", description: "Operator role read-only text commands editor", path: DASHBOARD_CHANNEL_PATH + "/modules/text_commands", role: "operator", interact: async (p) => { await p.locator("section.command-list table tbody tr").first().click(); } },
  { slug: "module-texts-list", description: "Texts page with the library table, filter bar, badges, and mandatory navigation heading", path: DASHBOARD_CHANNEL_PATH + "/modules/text_library" },
  { slug: "module-texts-selected", description: "Texts page with a text block inspector, preview, usage list, and pinned actions", path: DASHBOARD_CHANNEL_PATH + "/modules/text_library", interact: async (p) => { await p.locator(".text-library__table tbody tr").first().locator("button").click(); } },
  { slug: "module-texts-game-filter", description: "Texts page filtered to a selected Twitch game", path: DASHBOARD_CHANNEL_PATH + "/modules/text_library", interact: async (p) => {
    await p.getByRole("searchbox", { name: "Game" }).fill("Grand");
    await p.getByRole("option", { name: "Grand Theft Auto V" }).waitFor({ state: "visible" });
    await p.getByRole("option", { name: "Grand Theft Auto V" }).click();
    await p.locator(".text-library__filters .ui-game-picker__chip").filter({ hasText: "Grand Theft Auto V" }).waitFor({ state: "visible" });
  } },
  { slug: "module-texts-categories", description: "Texts page with category and channel time zone settings open", path: DASHBOARD_CHANNEL_PATH + "/modules/text_library", interact: async (p) => { await p.locator("summary").filter({ hasText: "Categories and time zone" }).click(); } },
  { slug: "operator-texts", description: "Operator role read-only Texts page with a selected block", path: DASHBOARD_CHANNEL_PATH + "/modules/text_library", role: "operator", interact: async (p) => { await p.locator(".text-library__table tbody tr").first().locator("button").click(); } },
];

test("capture BroBot dashboard pages for design review", async ({ browser }) => {
  test.setTimeout(900_000);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const shots: Shot[] = [];
  const missed: Array<{ file: string; error: string }> = [];
  let sequence = 0;
  for (const width of [1440, 390]) {
    for (const capture of captures) {
      sequence += 1;
      const height = width === 390 ? 844 : 1000;
      const role = capture.role ?? "broadcaster";
      const mode = capture.mode ?? "normal";
      const filename = String(sequence).padStart(2, "0") + "-" + capture.slug + "-" + String(width) + ".png";
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(10_000);
      const consoleErrors: string[] = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("pageerror", (error) => consoleErrors.push("pageerror: " + error.message));
      try {
        console.log("design capture start " + filename);
        await installMocks(page, role, mode);
        await page.goto(capture.path, { waitUntil: "domcontentloaded", timeout: 15_000 });
        console.log("design capture loaded " + filename);
        await page.locator("#root").waitFor({ state: "attached", timeout: 10_000 });
        if (mode === "login-required") await page.locator(".auth-screen").waitFor({ state: "visible", timeout: 10_000 });
        else {
          await page.locator(".main-content").waitFor({ state: "visible", timeout: 10_000 });
          if (capture.slug.startsWith("module-") || capture.slug.startsWith("operator-text")) {
            await page.locator(".module-detail").waitFor({ state: "visible", timeout: 10_000 });
            await page.getByText("Loading module views …", { exact: true }).waitFor({ state: "detached", timeout: 30_000 });
            if (capture.slug.includes("texts")) await page.locator(".text-library").waitFor({ state: "visible", timeout: 30_000 });
            if (capture.slug === "module-ads") {
              await page.locator('section[aria-label="Next ad break"]').waitFor({ state: "visible", timeout: 15_000 });
            }
          }
        }
        if (capture.interact !== undefined) {
          await capture.interact(page);
          console.log("design capture interaction ready " + filename);
        }
        await Promise.race([page.evaluate(() => document.fonts.ready), page.waitForTimeout(1_500)]);
        await page.waitForTimeout(220);
        await page.screenshot({ path: join(OUTPUT_DIR, filename), fullPage: true, animations: "disabled", timeout: 20_000 });
        console.log("design capture saved " + filename);
        const metrics = await page.evaluate(() => {
          const viewportWidth = document.documentElement.clientWidth;
          const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
          return { documentWidth, horizontalOverflow: documentWidth > viewportWidth, overflowPixels: Math.max(0, documentWidth - viewportWidth) };
        });
        shots.push({ file: filename, description: capture.description, width, height, role, mode, consoleErrors: [...consoleErrors], ...metrics });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        missed.push({ file: filename, error: message });
        shots.push({ file: filename, description: capture.description, width, height, role, mode, consoleErrors: [...consoleErrors], horizontalOverflow: null, documentWidth: null, overflowPixels: null, captureError: message });
      } finally {
        await page.close();
      }
    }
  }
  const captured = shots.filter((shot) => shot.captureError === undefined);
  const index = [
    "# BroBot dashboard design captures", "",
    "Screenshots use fictional dashboard data and mocked API responses. Each state is captured at 1440 px and 390 px wide.", "",
    "| File | What it shows |", "| --- | --- |",
    ...captured.map((shot) => "| " + shot.file + " | " + shot.description + " |"), "",
  ].join("\n");
  await writeFile(join(OUTPUT_DIR, "index.md"), index, "utf8");
  await writeFile(join(OUTPUT_DIR, "report.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), outputDirectory: OUTPUT_DIR,
    viewports: [{ width: 1440, height: 1000 }, { width: 390, height: 844 }], shots, missed,
  }, null, 2), "utf8");
  if (missed.length > 0) throw new Error(String(missed.length) + " screenshot capture(s) failed. See design-shots/report.json.");
});
