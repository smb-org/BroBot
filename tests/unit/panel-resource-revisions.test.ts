import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { MODULES } from "../../src/modules/registry";
import { dashboardDataKeys, queryKeys } from "../../src/dashboard/data/keys";
import { reconcileDashboardRealtimeMessage, reconcileDashboardPanelResourceRevisions } from "../../src/dashboard/data/realtime";
import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import { loadTextLibrary } from "../../src/modules/text_library/panel/service";
import { authRouter } from "../../src/worker/auth/routes";
import { eventSubChannelIdForNotification, eventSubRouter } from "../../src/worker/eventsub";
import { realtimeRouter } from "../../src/worker/realtime";
import { panelRouter } from "../../src/worker/panel/routes";
import { moduleRouter } from "../../src/worker/panel/module-routes";
import { platformRouter } from "../../src/worker/platform/routes";
import { app } from "../../src/worker/worker-app";
import { createSessionCookie } from "../../src/worker/auth/session";
import { notifyCommittedResources, panelResourceChangedMessage, PANEL_RESOURCE_NOTIFIER_COVERAGE, readCompletePanelResourceRevisions, readPanelResourceRevisions } from "../../src/worker/panel-resources";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const nonPanelAllRoutes: ReadonlySet<string> = new Set(PANEL_RESOURCE_NOTIFIER_COVERAGE.nonPanelAllRoutes);
const writingGetRoutes = new Set(PANEL_RESOURCE_NOTIFIER_COVERAGE.explicitlyCommittedRoutes
  .map((route) => route.slice("GET ".length)));
const routeIsCovered = (path: string, pattern: string): boolean => {
  const pathParts = path.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    if (expected === "*") return true;
    const actual = pathParts[index];
    if (actual === undefined || (expected !== undefined && !expected.startsWith(":") && expected !== actual)) return false;
  }
  return pathParts.length === patternParts.length;
};
const routeNeedsNotifier = (
  route: { method: string; path: string },
  knownWritingGets: ReadonlySet<string> = writingGetRoutes,
): boolean => writeMethods.has(route.method) || (route.method === "GET" && knownWritingGets.has(route.path)) ||
  (route.method === "ALL" && !nonPanelAllRoutes.has(`${route.method} ${route.path}`));
const routeHasNotifier = (
  route: { method: string; path: string },
  patterns: readonly string[],
  explicitRoutes: ReadonlySet<string>,
  knownWritingGets: ReadonlySet<string> = writingGetRoutes,
  nonPanelWrites: ReadonlySet<string> = new Set(PANEL_RESOURCE_NOTIFIER_COVERAGE.nonPanelWriteRoutes),
  nonPanelReads: ReadonlySet<string> = new Set(PANEL_RESOURCE_NOTIFIER_COVERAGE.nonPanelGetRoutes),
): boolean => {
  const routeKey = `${route.method} ${route.path}`;
  if (explicitRoutes.has(routeKey) || nonPanelWrites.has(routeKey) || nonPanelAllRoutes.has(routeKey)) return true;
  if (route.method === "GET") {
    return nonPanelReads.has(route.path) || routeIsCovered(route.path, PANEL_RESOURCE_NOTIFIER_COVERAGE.channelRoutes);
  }
  if (!routeNeedsNotifier(route, knownWritingGets)) return true;
  return patterns.some((pattern) => routeIsCovered(route.path, pattern));
};

const addChannel = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
  ).bind(channelId, channelId, channelId).run();
};

interface PanelWriteRegressionCase {
  name: string;
  keys: (channelId: string) => readonly (readonly unknown[])[];
  write: (database: TestD1Database, channelId: string) => Promise<void>;
}

const panelWriteRegressions: readonly PanelWriteRegressionCase[] = [
  {
    name: "channel overview, settings, system and channel list",
    keys: (id) => [queryKeys.channels(), queryKeys.channel(id, "overview"), queryKeys.channel(id, "settings"), dashboardDataKeys.system(id)],
    write: async (database, id) => { await database.prepare("UPDATE channels SET display_name = 'Changed' WHERE channel_id = ?").bind(id).run(); },
  },
  {
    name: "channel timezone and location library values",
    keys: (id) => [moduleQueryKey(id, "text_library", "library")],
    write: async (database, id) => {
      await database.prepare(
        "UPDATE channels SET location_name = 'Berlin', location_latitude = 52.5, location_longitude = 13.4, location_time_zone = 'Europe/Berlin' WHERE channel_id = ?",
      ).bind(id).run();
    },
  },
  {
    name: "members and their channel summaries",
    keys: (id) => [dashboardDataKeys.members(id), queryKeys.channel(id, "overview"), queryKeys.channels()],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
         VALUES (?, 'member-1', 'operator', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).bind(id).run();
    },
  },
  {
    name: "events and module data",
    keys: (id) => [queryKeys.channel(id, "events", { module: null }), moduleQueryKey(id, "chat_voting", "panel")],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO event_log (event_id, channel_id, created_at, module_id, code, detail_json)
         VALUES ('event-write', ?, '2026-10-10T00:00:00.000Z', 'chat_voting', 'chat_voting.started', '{}')`,
      ).bind(id).run();
    },
  },
  {
    name: "audit log",
    keys: (id) => [dashboardDataKeys.audit(id, { person: null, area: null })],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO audit_log (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
         VALUES ('audit-write', 'user-1', '2026-10-10T00:00:00.000Z', ?, 'channel.updated', '{}', '{}')`,
      ).bind(id).run();
    },
  },
  {
    name: "variables and dependent editors",
    keys: (id) => [
      dashboardDataKeys.variables(id),
      moduleQueryKey(id, "text_commands", "commands"),
      moduleQueryKey(id, "text_commands", "template-variables"),
      moduleQueryKey(id, "chat_voting", "settings"),
      moduleQueryKey(id, "text_library", "library"),
    ],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
         VALUES (?, 'score', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).bind(id).run();
    },
  },
  {
    name: "overlays and derived variable consumers",
    keys: (id) => [
      dashboardDataKeys.overlays(id), dashboardDataKeys.overlay(id, "overlay-1"),
      dashboardDataKeys.variables(id), moduleQueryKey(id, "text_commands", "commands"),
      moduleQueryKey(id, "chat_voting", "settings"), moduleQueryKey(id, "text_library", "library"),
    ],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
         VALUES ('overlay-1', ?, 'Gameplay', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).bind(id).run();
    },
  },
  {
    name: "overlay access",
    keys: (id) => [dashboardDataKeys.overlays(id), dashboardDataKeys.overlayAccesses(id, "overlay-1"), dashboardDataKeys.legacyOverlayTokens(id)],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO overlay_tokens (token_id, channel_id, token_hash, created_at)
         VALUES ('token-1', ?, 'hash-1', '2026-10-10T00:00:00.000Z')`,
      ).bind(id).run();
    },
  },
  {
    name: "text library and library catalog",
    keys: (id) => [
      moduleQueryKey(id, "text_library", "library"), moduleQueryKey(id, "timers", "panel"),
      moduleQueryKey(id, "faq", "panel"), moduleQueryKey(id, "text_commands", "template-variables"),
    ],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO text_library_settings (channel_id, updated_at)
         VALUES (?, '2026-10-10T00:00:00.000Z')`,
      ).bind(id).run();
    },
  },
  {
    name: "module settings and module registry",
    keys: (id) => [
      queryKeys.channel(id, "modules"), queryKeys.channel(id, "overview"), queryKeys.channels(),
      dashboardDataKeys.system(id), moduleQueryKey(id, "text_library", "library"),
      dashboardDataKeys.variables(id), moduleQueryKey(id, "chat_voting", "settings"),
      moduleQueryKey(id, "chat_voting", "panel"), moduleQueryKey(id, "text_commands", "commands"),
    ],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES (?, 'chat_voting', 1, '{}')`,
      ).bind(id).run();
    },
  },
  {
    name: "chat voting tallies",
    keys: (id) => [moduleQueryKey(id, "chat_voting", "panel")],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO chat_votes (channel_id, poll_id, kind, preset, legacy_written, option_count, labels_json, status, opened_at, closes_at, close_reason)
         VALUES (?, 'poll-1', 'yes_no', 'yes_no', 0, 2, '["Yes","No"]', 'open', '2026-10-10T00:00:00.000Z', '2026-10-10T00:02:00.000Z', 'manual')`,
      ).bind(id).run();
    },
  },
  {
    name: "chat voting word approvals",
    keys: (id) => [moduleQueryKey(id, "chat_voting", "panel")],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO chat_votes (channel_id, poll_id, kind, preset, legacy_written, option_count, labels_json, text_mode, term_filter_ready, status, opened_at, closes_at, close_reason)
         VALUES (?, 'poll-words', 'free_text', 'free_text', 0, 0, '[]', 'first_word', 1, 'open', '2026-10-10T00:00:00.000Z', '2026-10-10T00:02:00.000Z', 'manual')`,
      ).bind(id).run();
      await database.prepare(
        `INSERT INTO chat_vote_term_approvals (channel_id, poll_id, term, approved_at, approved_by)
         VALUES (?, 'poll-words', 'pizza', '2026-10-10T00:00:01.000Z', 'manager-1')`,
      ).bind(id).run();
    },
  },
  {
    name: "votekick state",
    keys: (id) => [moduleQueryKey(id, "votekick", "panel")],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO votekicks (channel_id, votekick_id, status, threshold, started_at, expires_at)
         VALUES (?, 'kick-1', 'running', 2, '2026-10-10T00:00:00.000Z', '2026-10-10T00:02:00.000Z')`,
      ).bind(id).run();
    },
  },
  {
    name: "BELABOX samples",
    keys: (id) => [
      moduleQueryKey(id, "belabox", "status"), moduleQueryKey(id, "belabox", "streams"),
      moduleQueryKey(id, "belabox", "history-live"),
    ],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO belabox_status (channel_id, sampled_at, sample_json, error_code, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json)
         VALUES (?, '2026-10-10T00:00:00.000Z', '{}', NULL, 1, 'stream-1', 'belabox-1', '{}', '[]')`,
      ).bind(id).run();
    },
  },
  {
    name: "ad schedule",
    keys: (id) => [moduleQueryKey(id, "ads", "schedule")],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO ads_countdown_state (channel_id, next_ad_at, duration, snooze_count, updated_at)
         VALUES (?, '2026-10-10T00:05:00.000Z', 60, 0, '2026-10-10T00:00:00.000Z')`,
      ).bind(id).run();
    },
  },
  {
    name: "shared weather cache",
    keys: (id) => [moduleQueryKey(id, "text_library", "library")],
    write: async (database, id) => {
      await database.prepare(
        "UPDATE channels SET location_latitude = 52.5, location_longitude = 13.4 WHERE channel_id = ?",
      ).bind(id).run();
      await database.prepare(
        `INSERT INTO weather_cache (provider, location_key, latitude, longitude, payload_json, expires_at, updated_at)
         VALUES ('met_norway', 'test-location', 52.5, 13.4, '{}', '2026-10-10T01:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).run();
    },
  },
  {
    name: "shared API cache",
    keys: (id) => [moduleQueryKey(id, "text_library", "library")],
    write: async (database, id) => {
      await database.prepare(
        `INSERT INTO api_source_cache (url_hash, channel_id, payload_json, expires_at, updated_at)
         VALUES ('${"a".repeat(64)}', ?, '{}', '2026-10-10T01:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).bind(id).run();
    },
  },
];

describe("panel resource revisions", () => {
  it("guards every assembled mutating route and module alarm with a notifier seam", () => {
    const root = resolve(import.meta.dirname, "../..");
    const routers = [panelRouter, moduleRouter, platformRouter, authRouter, eventSubRouter, realtimeRouter];
    const assembledRoutes = app.routes;
    const mutations = assembledRoutes.filter((route) => routeNeedsNotifier(route));
    expect(mutations.length).toBeGreaterThan(0);
    const routePatterns = [
      PANEL_RESOURCE_NOTIFIER_COVERAGE.channelRoutes,
      PANEL_RESOURCE_NOTIFIER_COVERAGE.platformRoutes,
      PANEL_RESOURCE_NOTIFIER_COVERAGE.eventSubRoute,
    ];
    const explicitRoutes = new Set(PANEL_RESOURCE_NOTIFIER_COVERAGE.explicitlyCommittedRoutes);
    const nonPanelGetRoutes = new Set<string>(PANEL_RESOURCE_NOTIFIER_COVERAGE.nonPanelGetRoutes);
    const nonPanelWrites = new Set<string>(PANEL_RESOURCE_NOTIFIER_COVERAGE.nonPanelWriteRoutes);
    expect(new Set([...writingGetRoutes].map((path) => `GET ${path}`))).toEqual(explicitRoutes);
    const uncovered = mutations.filter((route) => !routeHasNotifier(route, routePatterns, explicitRoutes, writingGetRoutes, nonPanelWrites));
    expect(uncovered).toEqual([]);
    const unaccountedGets = assembledRoutes.filter(({ method, path }) => method === "GET" &&
      !routeIsCovered(path, PANEL_RESOURCE_NOTIFIER_COVERAGE.channelRoutes) &&
      !writingGetRoutes.has(path) && !nonPanelGetRoutes.has(path));
    expect(unaccountedGets).toEqual([]);
    for (const router of routers) {
      for (const route of router.routes) {
        expect(assembledRoutes.some(({ method, path }) => method === route.method && path === route.path),
          `${route.method} ${route.path} must be mounted in the root app`).toBe(true);
      }
    }
    expect(assembledRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: "/healthz" }),
      expect.objectContaining({ method: "GET", path: "/overlay" }),
      expect.objectContaining({ method: "GET", path: "/overlay.html" }),
      expect.objectContaining({ method: "ALL", path: "/api/*" }),
      expect.objectContaining({ method: "ALL", path: "/*" }),
    ]));
    expect(routeHasNotifier(
      { method: "POST", path: "/api/unwrapped-write" }, routePatterns, explicitRoutes,
    )).toBe(false);
    expect(routeHasNotifier(
      { method: "POST", path: "/unwrapped-root-write" }, routePatterns, explicitRoutes,
    )).toBe(false);
    expect(routeHasNotifier(
      { method: "POST", path: "/api/twitch/eventsub-rogue" }, routePatterns, explicitRoutes,
    )).toBe(false);
    expect(routeHasNotifier(
      { method: "ALL", path: "/api/realtime/unwrapped-write" }, routePatterns, explicitRoutes,
    )).toBe(false);
    const unwrappedWritingGet = { method: "GET", path: "/api/realtime/unwrapped-write" };
    expect(routeHasNotifier(
      unwrappedWritingGet,
      routePatterns,
      explicitRoutes,
      new Set([...writingGetRoutes, unwrappedWritingGet.path]),
    )).toBe(false);
    const unnotifiedPlatformWritingGet = { method: "GET", path: "/api/platform/writing-get" };
    expect(routeHasNotifier(
      unnotifiedPlatformWritingGet,
      routePatterns,
      explicitRoutes,
      new Set([...writingGetRoutes, unnotifiedPlatformWritingGet.path]),
    )).toBe(false);
    expect(routeHasNotifier(
      { method: "GET", path: "/api/platform/unclassified-read" },
      routePatterns,
      explicitRoutes,
    )).toBe(false);

    const moduleMutations = MODULES.flatMap((module) => module.routes?.routes ?? [])
      .filter(({ method }) => writeMethods.has(method));
    const chatVoting = MODULES.find(({ id }) => id === "chat_voting");
    const chatVotingRoutes = chatVoting?.routes?.routes ?? [];
    const chatVotingMutations = chatVotingRoutes.filter(({ method }) => writeMethods.has(method));
    const moduleAlarms = MODULES.flatMap((module) => module.alarms ?? []);
    const maintenanceJobs = MODULES.filter((module) => module.scheduledMaintenance !== undefined);
    expect(moduleMutations.length).toBeGreaterThan(0);
    expect(chatVoting).toBeDefined();
    expect(chatVotingMutations.map(({ method, path }) => `${method} ${path.slice(path.lastIndexOf("/"))}`)).toEqual(
      expect.arrayContaining(["POST /start", "POST /approve-term", "POST /close"]),
    );
    expect(chatVotingRoutes.some(({ method, path }) => method === "GET" && path.endsWith("/current"))).toBe(true);
    for (const { path } of chatVotingRoutes) {
      const mountedPath = path.startsWith("/api/channels/")
        ? path
        : `/api/channels/:channelId/modules/chat_voting${path}`;
      expect(routeIsCovered(mountedPath, PANEL_RESOURCE_NOTIFIER_COVERAGE.channelRoutes)).toBe(true);
    }
    expect(chatVoting?.eventSubTypes).toContain("channel.chat.message");
    expect(chatVoting?.alarms?.length ?? 0).toBeGreaterThan(0);
    expect(PANEL_RESOURCE_NOTIFIER_COVERAGE.moduleRoutes).toBe("channelRoutes");
    const moduleRouterSource = readFileSync(resolve(root, "src/worker/panel/module-routes.ts"), "utf8");
    expect(moduleRouterSource).toContain("moduleRouter.route(`/api/channels/:channelId/modules/${module.id}`, module.routes)");
    const authRouteSource = readFileSync(resolve(root, "src/worker/auth/routes.ts"), "utf8");
    expect(authRouteSource).toMatch(/authRouter\.get\("\/api\/overlay\/bootstrap"[\s\S]*?finally \{[\s\S]*?notifyCommittedResources\(context\.env, record\.channelId\)/u);
    expect(moduleAlarms.length).toBeGreaterThan(0);
    expect(maintenanceJobs.length).toBeGreaterThan(0);
    expect(PANEL_RESOURCE_NOTIFIER_COVERAGE.channelAlarm).toBe("ChannelObject.alarm.finally");
    expect(PANEL_RESOURCE_NOTIFIER_COVERAGE.scheduledMaintenance).toBe("scheduled.finally");
    expect(PANEL_RESOURCE_NOTIFIER_COVERAGE.eventSubHandler).toBe("eventSubRouter notification/revocation finally");

    const channelObject = readFileSync(resolve(root, "src/worker/durable/ChannelObject.ts"), "utf8");
    expect(channelObject).toContain("moduleAlarmHandlerEntries(modules)");
    const alarm = /override async alarm\(\): Promise<void>\s+\{([\s\S]*?)\n\s+\}\n\n\s+override webSocketMessage/u.exec(channelObject)?.[1] ?? "";
    expect(alarm).toMatch(/finally \{\s*await this\.notifyCommittedPanelResources\(\);/u);
    expect(alarm).toContain("this.alarmHandlers(MODULES");
    const alarmStart = channelObject.indexOf("public async runModuleAlarm(");
    const alarmEnd = channelObject.indexOf("private ballotAccess(", alarmStart);
    const directAlarm = alarmStart < 0 || alarmEnd < 0 ? "" : channelObject.slice(alarmStart, alarmEnd);
    expect(directAlarm).toMatch(/finally \{\s*await this\.notifyCommittedPanelResources\(\);/u);
    const alarmStorageStart = channelObject.indexOf("storage: {", channelObject.indexOf("private moduleAlarmContext("));
    const alarmStorageEnd = channelObject.indexOf("schedule:", alarmStorageStart);
    const alarmStorage = alarmStorageStart < 0 || alarmStorageEnd < 0
      ? ""
      : channelObject.slice(alarmStorageStart, alarmStorageEnd);
    expect(alarmStorage).toContain("this.ctx.storage.transaction");
    expect(alarmStorage).toContain("bumpDurablePanelResources(transaction, [`module:${moduleId}:data`])");
    const scheduled = readFileSync(resolve(root, "src/worker/scheduled.ts"), "utf8");
    expect(scheduled).toContain(".finally(async () => {");
    expect(scheduled).toContain("await notifyCommittedResources(env);");
    const worker = readFileSync(resolve(root, "src/worker/app-routes.ts"), "utf8");
    expect(worker).toContain("app.use(PANEL_RESOURCE_NOTIFIER_COVERAGE.channelRoutes");
    expect(worker).toContain("app.use(PANEL_RESOURCE_NOTIFIER_COVERAGE.platformRoutes");
    expect(worker).toMatch(/finally \{\s*const channelId = context\.req\.param\("channelId"\);\s*if \(channelId\.length > 0 && authorizedContextHas\(context, "session"\)\) \{\s*await notifyCommittedResources\(context\.env\);/u);
    expect(worker).not.toContain("PANEL_RESOURCE_NOTIFIER_COVERAGE.authRoutes");
    expect(worker).not.toMatch(/context\.res\.status !== 401/u);
    const rootWorker = readFileSync(resolve(root, "src/worker/worker-app.ts"), "utf8");
    expect(rootWorker).toContain('app.get("/healthz"');
    expect(rootWorker).toContain('app.all("/api/*"');
    expect(rootWorker).toContain('app.all("*"');
    const ballotStorageStart = channelObject.indexOf("private ballotStorage(");
    const ballotStorageEnd = channelObject.indexOf("private async notifyCommittedPanelResources(", ballotStorageStart);
    const ballotStorage = ballotStorageStart < 0 || ballotStorageEnd < 0 ? "" : channelObject.slice(ballotStorageStart, ballotStorageEnd);
    expect(ballotStorage).toContain("this.ballotPanelResources(match[1])");
    expect(ballotStorage).toMatch(/bumpDurablePanelResources\(underlying, \[\.\.\.changedResources\]\)/u);
    const ballotCastStart = channelObject.indexOf("public async castBallot(");
    const ballotTermCastStart = channelObject.indexOf("public async castBallotTerm(", ballotCastStart);
    const ballotCast = ballotCastStart < 0 || ballotTermCastStart < 0 ? "" : channelObject.slice(ballotCastStart, ballotTermCastStart);
    expect(ballotCast).toContain("choice, options");
    expect(ballotCast).toMatch(/result\.status === "counted" \|\| result\.status === "changed"\) \{\s*await this\.notifyCommittedPanelResources\(\);/u);
    const ballotTermCastEnd = channelObject.indexOf("public async setBlockedTerms(", ballotTermCastStart);
    const ballotTermCast = ballotTermCastStart < 0 || ballotTermCastEnd < 0 ? "" : channelObject.slice(ballotTermCastStart, ballotTermCastEnd);
    expect(ballotTermCast).toContain("castStoredBallotTerm");
    expect(ballotTermCast).toContain('result.status === "overflow"');
    expect(ballotTermCast).toContain("await this.notifyCommittedPanelResources()");
    const eventSubSource = readFileSync(resolve(root, "src/worker/eventsub.ts"), "utf8");
    expect(eventSubSource).toMatch(/finally \{\s*await notifyCommittedResources\(context\.env, notifierChannelId\);/u);
    expect(eventSubSource).toMatch(/revokeRealtimeUserFromAllChannels\([\s\S]*?revocation\.authorizationIdentity\.userId/u);
    const authSource = readFileSync(resolve(root, "src/worker/auth/routes.ts"), "utf8");
    expect(authSource.match(/finally \{\s*await notifyCommittedResources\(env\);/gu) ?? []).toHaveLength(2);
    expect(authSource).toMatch(/await upsertBotIdentityAndStatus\([\s\S]*?await notifyCommittedResources\(context\.env\);/u);
    expect(authSource).toMatch(/await upsertLoginIdentity\([\s\S]*?await notifyCommittedResources\(context\.env\);/u);
    const memberRoutes = readFileSync(resolve(root, "src/worker/panel/member-routes.ts"), "utf8");
    const platformRoutes = readFileSync(resolve(root, "src/worker/platform/routes.ts"), "utf8");
    const loginMaintenance = readFileSync(resolve(root, "src/worker/login-maintenance.ts"), "utf8");
    expect(memberRoutes).toMatch(/if \(!changed\) return[\s\S]*?await revokeRealtimeUser\(context\.env\.CHANNEL, channelId, userId\);/u);
    expect(platformRoutes).toMatch(/if \(!changed\) return[\s\S]*?await revokeRealtimeUser\(context\.env\.CHANNEL, channelId, userId\);/u);
    expect(authSource).toMatch(/await revokeSession\(context\.env\.DB, session\.sessionId, now, "logout"\);\s*await revokeRealtimeSessionForUser/u);
    expect(loginMaintenance).toMatch(/if \(revoked\) \{\s*const pending = await getPendingRealtimeUserRevocation[\s\S]*?await revokeRealtimeUserFromAllChannels/u);
  });

  it("does not enumerate channels for an unauthenticated OAuth callback", async () => {
    const prepare = vi.fn();
    const idFromName = vi.fn((channelId: string) => channelId);
    const env = {
      DB: { prepare } as unknown as D1Database,
      CHANNEL: { idFromName, get: vi.fn() },
      PUBLIC_ORIGIN: "https://brobot.example",
    } as unknown as Env;

    const response = await app.fetch(
      new Request("https://brobot.example/auth/twitch/callback"),
      env,
    );

    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("publishes every channel queued by an authenticated channel request", async () => {
    const database = new TestD1Database();
    const visitedChannels: string[] = [];
    const cookieKeys = JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] });
    const encryptionKeys = JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] });
    try {
      await insertChannel(database, "cross-channel-a");
      await insertChannel(database, "cross-channel-b");
      await insertLoginIdentityAndSession(database, "cross-channel-manager");
      await insertMember(database, "cross-channel-a", "cross-channel-manager", "manager");
      await database.prepare("DELETE FROM panel_resource_pending").run();

      const env = {
        DB: database as unknown as D1Database,
        SESSION_COOKIE_KEYS: cookieKeys,
        SESSION_ENCRYPTION_KEYS: encryptionKeys,
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: (channelId: string) => ({
            getPanelResourceRevisions: () => Promise.resolve({}),
            reconcilePanelResources: () => { visitedChannels.push(channelId); return Promise.resolve(); },
          }),
        },
      } as unknown as Env;
      const sessionCookie = await createSessionCookie(
        { sessionId: "session-cross-channel-manager" },
        cookieKeys,
        encryptionKeys,
      );

      // The target user's channel list is shared across channels, so this
      // membership commit queues revisions for both existing channel sockets.
      await insertMember(database, "cross-channel-a", "new-channel-member", "operator");
      const response = await app.fetch(new Request(
        "https://brobot.example/api/channels/cross-channel-a/revisions",
        { headers: { Cookie: `__Host-brobot_session=${sessionCookie}` } },
      ), env);

      expect(response.status).toBe(200);
      expect(visitedChannels.sort((left, right) => left.localeCompare(right)))
        .toEqual(["cross-channel-a", "cross-channel-b"]);
      const remaining = await database.prepare(
        "SELECT channel_id FROM panel_resource_pending ORDER BY channel_id LIMIT 1",
      ).first<{ channel_id: string }>();
      expect(remaining).toBeNull();
    } finally {
      database.close();
    }
  });

  it("does not fan out queued revisions from an unauthenticated channel request", async () => {
    const database = new TestD1Database();
    const getChannel = vi.fn();
    try {
      await insertChannel(database, "unauthenticated-a");
      await insertChannel(database, "unauthenticated-b");
      await database.prepare("DELETE FROM panel_resource_pending").run();
      await database.prepare(
        `UPDATE panel_resource_revisions SET revision = revision + 1
          WHERE channel_id = 'unauthenticated-b' AND resource = 'channel.overview'`,
      ).run();
      const env = {
        DB: database as unknown as D1Database,
        CHANNEL: { idFromName: (channelId: string) => channelId, get: getChannel },
      } as unknown as Env;

      const response = await app.fetch(new Request(
        "https://brobot.example/api/channels/unauthenticated-a/revisions",
      ), env);

      expect(response.status).toBe(401);
      expect(getChannel).not.toHaveBeenCalled();
      const pending = await database.prepare(
        "SELECT channel_id FROM panel_resource_pending WHERE channel_id = 'unauthenticated-b'",
      ).first<{ channel_id: string }>();
      expect(pending?.channel_id).toBe("unauthenticated-b");
    } finally {
      database.close();
    }
  });

  it("uses the subscription registry to resolve EventSub notifier channels, including raid directions", () => {
    expect(eventSubChannelIdForNotification({
      subscription: { type: "channel.raid", condition: { to_broadcaster_user_id: "incoming-channel" } },
      event: {},
    })).toBe("incoming-channel");
    expect(eventSubChannelIdForNotification({
      subscription: { type: "channel.raid", condition: { from_broadcaster_user_id: "outgoing-channel" } },
      event: {},
    })).toBe("outgoing-channel");
    expect(eventSubChannelIdForNotification({
      subscription: { type: "channel.chat.message", condition: { broadcaster_user_id: "trusted-channel" } },
      event: { broadcaster_user_id: "foreign-channel" },
    })).toBe("trusted-channel");
  });

  it("advances dashboard resources with their D1 commits and isolates channels", async () => {
    const database = new TestD1Database();
    try {
      await addChannel(database, "revision-a");
      await addChannel(database, "revision-b");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
         VALUES ('revision-a', 'score', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).run();
      await database.prepare(
        `INSERT INTO event_log (event_id, channel_id, created_at, module_id, code, detail_json)
         VALUES ('event-a', 'revision-a', '2026-10-10T00:00:00.000Z', 'chat_voting', 'chat_voting.started', '{}')`,
      ).run();

      const first = await readPanelResourceRevisions(database as unknown as D1Database, "revision-a");
      const second = await readPanelResourceRevisions(database as unknown as D1Database, "revision-b");
      expect(first["channel.variables"]).toBe(1);
      expect(first["channel.events"]).toBe(1);
      expect(first["module:chat_voting:data"]).toBe(1);
      expect(second["channel.variables"]).toBeUndefined();
      expect(second["channel.events"]).toBeUndefined();
      expect(second["module:chat_voting:data"]).toBeUndefined();

      const eventRevision = first["channel.events"];
      await expect(database.batch([
        database.prepare(
          `INSERT INTO event_log (event_id, channel_id, created_at, module_id, code, detail_json)
           VALUES ('event-failed', 'revision-a', '2026-10-10T00:00:01.000Z', 'chat_voting', 'chat_voting.failed', '{}')`,
        ),
        database.prepare(
          `INSERT INTO event_log (event_id, channel_id, created_at, module_id, code, detail_json)
           VALUES ('event-failed', 'revision-a', '2026-10-10T00:00:02.000Z', 'chat_voting', 'chat_voting.duplicate', '{}')`,
        ),
      ])).rejects.toThrow();
      const afterRollback = await readPanelResourceRevisions(database as unknown as D1Database, "revision-a");
      expect(afterRollback["channel.events"]).toBe(eventRevision);
      expect(afterRollback["module:chat_voting:data"]).toBe(1);

      const hint = panelResourceChangedMessage("revision-a", ["module:belabox:live"], {
        "module:belabox:live": 2,
      });
      expect(hint.payload).toEqual({ resources: ["module:belabox:live"], revisions: { "module:belabox:live": 2 } });
      expect(JSON.stringify(hint)).not.toMatch(/statsUrl|publisherKey|relay-key|https?:/iu);
    } finally {
      database.close();
    }
  });

  it("refreshes a second panel client after a committed D1 write and notifier hint", async () => {
    const database = new TestD1Database();
    const writer = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reader = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const channelId = "revision-two-client";
    const queryKey = dashboardDataKeys.variables(channelId);
    let unsubscribe: (() => void) | undefined;
    try {
      await addChannel(database, channelId);
      reader.setQueryData(queryKey, { variables: [] });
      let reads = 0;
      const observer = new QueryObserver(reader, {
        queryKey,
        queryFn: () => { reads += 1; return Promise.resolve({ variables: [] }); },
        staleTime: Infinity,
      });
      unsubscribe = observer.subscribe(() => undefined);
      let published: Readonly<Record<string, number>> = {};
      const env = {
        DB: database as unknown as D1Database,
        CHANNEL: {
          idFromName: (id: string) => id,
          get: () => ({ reconcilePanelResources: (revisions: Readonly<Record<string, number>>) => {
            published = revisions;
            return Promise.resolve();
          } }),
        },
      } as unknown as Env;

      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        revisions: await readPanelResourceRevisions(database as unknown as D1Database, channelId),
      }), { status: 200, headers: { "Content-Type": "application/json" } })));
      await Promise.all([
        reconcileDashboardPanelResourceRevisions(writer, channelId),
        reconcileDashboardPanelResourceRevisions(reader, channelId),
      ]);

      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
         VALUES (?, 'score', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).bind(channelId).run();
      await notifyCommittedResources(env, channelId);
      expect(published["channel.variables"]).toBe(1);
      await reconcileDashboardRealtimeMessage(reader, panelResourceChangedMessage(
        channelId,
        ["channel.variables"],
        published,
      ));

      await vi.waitFor(() => { expect(reads).toBe(1); });
    } finally {
      unsubscribe?.();
      writer.clear();
      reader.clear();
      vi.unstubAllGlobals();
      database.close();
    }
  });

  it("reloads the production text-library query after timezone and location changes", async () => {
    const database = new TestD1Database();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const channelId = "library-settings-revisions";
    const queryKey = moduleQueryKey(channelId, "text_library", "library");
    let unsubscribe: (() => void) | undefined;
    const requestUrl = (input: RequestInfo | URL): string =>
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
      await addChannel(database, channelId);
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.endsWith("/revisions")) {
          return new Response(JSON.stringify({ revisions: await readPanelResourceRevisions(database as unknown as D1Database, channelId) }), { status: 200 });
        }
        if (url.includes("/modules/text_library/")) {
          return new Response(JSON.stringify({ blocks: [], categories: [], usage: {} }), { status: 200 });
        }
        if (url.endsWith("/template-variables")) return new Response(JSON.stringify({ variables: [] }), { status: 200 });
        if (url.endsWith("/settings")) return new Response(JSON.stringify({ timeZone: "UTC", revision: 0 }), { status: 200 });
        throw new Error(`Unexpected library fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetcher);
      await reconcileDashboardPanelResourceRevisions(queryClient, channelId);
      const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: ({ signal }) => loadTextLibrary(channelId, signal),
        staleTime: Infinity,
      });
      unsubscribe = observer.subscribe(() => undefined);
      const libraryRequestCount = (): number => fetcher.mock.calls.filter(([input]) => requestUrl(input).includes("/modules/text_library/")).length;
      await vi.waitFor(() => { expect(libraryRequestCount()).toBe(1); });

      await database.prepare("UPDATE channels SET location_time_zone = 'Europe/Berlin' WHERE channel_id = ?").bind(channelId).run();
      await reconcileDashboardPanelResourceRevisions(queryClient, channelId);
      await vi.waitFor(() => { expect(libraryRequestCount()).toBe(2); });

      await database.prepare("UPDATE channels SET location_name = 'Berlin', location_latitude = 52.5, location_longitude = 13.4 WHERE channel_id = ?").bind(channelId).run();
      await reconcileDashboardPanelResourceRevisions(queryClient, channelId);
      await vi.waitFor(() => { expect(libraryRequestCount()).toBe(3); });
    } finally {
      unsubscribe?.();
      queryClient.clear();
      vi.unstubAllGlobals();
      database.close();
    }
  });

  it.each(panelWriteRegressions)("$name refreshes each affected query on the second client", async (scenario) => {
    const database = new TestD1Database();
    const channelId = "revision-two-client";
    const writer = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reader = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKeysForWrite = scenario.keys(channelId);
    const refetchCounts = queryKeysForWrite.map(() => 0);
    const unsubscribers: Array<() => void> = [];
    let published: Readonly<Record<string, number>> = {};
    try {
      await addChannel(database, channelId);
      const env = {
        DB: database as unknown as D1Database,
        CHANNEL: {
          idFromName: (id: string) => id,
          get: () => ({ reconcilePanelResources: (revisions: Readonly<Record<string, number>>) => {
            published = revisions;
            return Promise.resolve();
          } }),
        },
      } as unknown as Env;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        revisions: await readPanelResourceRevisions(database as unknown as D1Database, channelId),
      }), { status: 200, headers: { "Content-Type": "application/json" } })));
      await Promise.all([
        reconcileDashboardPanelResourceRevisions(writer, channelId),
        reconcileDashboardPanelResourceRevisions(reader, channelId),
      ]);
      queryKeysForWrite.forEach((queryKey, index) => {
        writer.setQueryData(queryKey, { initial: true });
        reader.setQueryData(queryKey, { initial: true });
        const observer = new QueryObserver(reader, {
          queryKey,
          queryFn: () => {
            refetchCounts[index] = (refetchCounts[index] ?? 0) + 1;
            return Promise.resolve({ refreshed: true });
          },
          staleTime: Infinity,
        });
        unsubscribers.push(observer.subscribe(() => undefined));
      });
      const beforeWrite = await readPanelResourceRevisions(database as unknown as D1Database, channelId);

      await scenario.write(database, channelId);
      await notifyCommittedResources(env, channelId);
      const changedResources = Object.keys(published).filter((resource) =>
        (published[resource] ?? 0) > (beforeWrite[resource] ?? 0));
      expect(changedResources.length).toBeGreaterThan(0);
      await reconcileDashboardRealtimeMessage(reader, panelResourceChangedMessage(channelId, changedResources, published));

      await vi.waitFor(() => { expect(refetchCounts).toEqual(Array.from({ length: queryKeysForWrite.length }, () => 1)); });
      expect(writer.getQueryCache().getAll().every((query) => !query.isActive())).toBe(true);
    } finally {
      unsubscribers.forEach((unsubscribe) => { unsubscribe(); });
      writer.clear();
      reader.clear();
      vi.unstubAllGlobals();
      database.close();
    }
  });

  it("publishes a committed revision when later route work fails", async () => {
    const database = new TestD1Database();
    try {
      await addChannel(database, "revision-failure");
      const reconcilePanelResources = vi.fn(() => Promise.resolve());
      const env = {
        DB: database as unknown as D1Database,
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: () => ({ reconcilePanelResources }),
        },
      } as unknown as Env;

      await expect((async () => {
        try {
          await database.prepare(
            `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
             VALUES ('revision-failure', 'score', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
          ).run();
          throw new Error("later route work failed");
        } finally {
          await notifyCommittedResources(env, "revision-failure");
        }
      })()).rejects.toThrow("later route work failed");

      expect(reconcilePanelResources).toHaveBeenCalledWith(expect.objectContaining({ "channel.variables": 1 }));
    } finally {
      database.close();
    }
  });

  it("queues only the owner channel when an API cache commit changes library values", async () => {
    const database = new TestD1Database();
    const visitedChannels: string[] = [];
    try {
      await addChannel(database, "api-cache-owner");
      await addChannel(database, "api-cache-other");
      await database.prepare("DELETE FROM panel_resource_pending").run();
      const ownerBefore = (await readPanelResourceRevisions(database as unknown as D1Database, "api-cache-owner"))["channel.library"] ?? 0;
      const otherBefore = (await readPanelResourceRevisions(database as unknown as D1Database, "api-cache-other"))["channel.library"] ?? 0;
      await database.prepare(
        `INSERT INTO api_source_cache (url_hash, channel_id, payload_json, expires_at, updated_at)
         VALUES (?, 'api-cache-owner', '{}', '2026-10-10T01:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).bind("a".repeat(64)).run();
      const env = {
        DB: database as unknown as D1Database,
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: (channelId: string) => ({
            reconcilePanelResources: () => { visitedChannels.push(channelId); return Promise.resolve(); },
          }),
        },
      } as unknown as Env;

      await notifyCommittedResources(env);

      expect(visitedChannels).toEqual(["api-cache-owner"]);
      expect((await readPanelResourceRevisions(database as unknown as D1Database, "api-cache-owner"))["channel.library"])
        .toBe(ownerBefore + 1);
      expect((await readPanelResourceRevisions(database as unknown as D1Database, "api-cache-other"))["channel.library"])
        .toBe(otherBefore);
    } finally {
      database.close();
    }
  });

  it("keeps legacy cache revisions available during migration-before-code rollout", async () => {
    const database = new TestD1Database();
    const visitedChannels: string[] = [];
    try {
      await addChannel(database, "legacy-cache-a");
      await addChannel(database, "legacy-cache-b");
      await database.prepare("DELETE FROM panel_resource_pending").run();
      const publicationTable = database.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'panel_global_resource_publications'",
      ).get() as { name: string } | undefined;
      expect(publicationTable?.name).toBe("panel_global_resource_publications");
      const revision = (resource: string): number => {
        const row = database.sqlite.prepare(
          "SELECT revision FROM panel_global_resource_revisions WHERE resource = ?",
        ).get(resource) as { revision: number };
        return row.revision;
      };
      const apiBefore = revision("api.cache");
      const weatherBefore = revision("weather.cache");
      const libraryBefore = new Map([
        ["legacy-cache-a", (await readPanelResourceRevisions(database as unknown as D1Database, "legacy-cache-a"))["channel.library"] ?? 0],
        ["legacy-cache-b", (await readPanelResourceRevisions(database as unknown as D1Database, "legacy-cache-b"))["channel.library"] ?? 0],
      ]);

      await database.prepare(
        `INSERT INTO api_source_cache (url_hash, payload_json, expires_at, updated_at)
         VALUES (?, '{}', '2026-10-10T01:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).bind("b".repeat(64)).run();
      await database.prepare(
        `INSERT INTO weather_cache
          (provider, location_key, latitude, longitude, payload_json, expires_at, updated_at)
         VALUES ('met_norway', 'legacy-location', 0, 0, '{}', '2026-10-10T01:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).run();

      expect(revision("api.cache")).toBe(apiBefore + 1);
      expect(revision("weather.cache")).toBe(weatherBefore + 1);

      const env = {
        DB: database as unknown as D1Database,
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: (channelId: string) => ({
            reconcilePanelResources: () => { visitedChannels.push(channelId); return Promise.resolve(); },
          }),
        },
      } as unknown as Env;
      await notifyCommittedResources(env);

      expect(visitedChannels.sort((left, right) => left.localeCompare(right)))
        .toEqual(["legacy-cache-a", "legacy-cache-b"]);
      for (const channelId of visitedChannels) {
        expect((await readPanelResourceRevisions(database as unknown as D1Database, channelId))["channel.library"])
          .toBe((libraryBefore.get(channelId) ?? 0) + 1);
      }

      await database.prepare("DELETE FROM panel_resource_pending").run();
      const ownedBefore = (await readPanelResourceRevisions(database as unknown as D1Database, "legacy-cache-a"))["channel.library"] ?? 0;
      const unrelatedBefore = (await readPanelResourceRevisions(database as unknown as D1Database, "legacy-cache-b"))["channel.library"] ?? 0;
      await database.prepare("UPDATE api_source_cache SET channel_id = 'legacy-cache-a' WHERE url_hash = ?")
        .bind("b".repeat(64)).run();

      expect((await readPanelResourceRevisions(database as unknown as D1Database, "legacy-cache-a"))["channel.library"])
        .toBe(ownedBefore + 1);
      expect((await readPanelResourceRevisions(database as unknown as D1Database, "legacy-cache-b"))["channel.library"])
        .toBe(unrelatedBefore);
      expect((database.sqlite.prepare("SELECT DISTINCT channel_id FROM panel_resource_pending").all() as Array<{ channel_id: string }>)
        .map(({ channel_id }) => channel_id)).toEqual(["legacy-cache-a"]);
    } finally {
      database.close();
    }
  });

  it("fans global bot status commits out to each affected channel", async () => {
    const database = new TestD1Database();
    const visitedChannels: string[] = [];
    try {
      await addChannel(database, "bot-status-a");
      await addChannel(database, "bot-status-b");
      await database.prepare("DELETE FROM panel_resource_pending").run();
      const env = {
        DB: database as unknown as D1Database,
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: (channelId: string) => ({
            reconcilePanelResources: () => { visitedChannels.push(channelId); return Promise.resolve(); },
          }),
        },
      } as unknown as Env;

      await database.prepare(
        `INSERT INTO bot_identity_status (id, status, reason, updated_at)
         VALUES (1, 'error', 'token_check_failed', '2026-10-10T00:00:00.000Z')`,
      ).run();
      await notifyCommittedResources(env);

      expect(visitedChannels.sort((left, right) => left.localeCompare(right))).toEqual(["bot-status-a", "bot-status-b"]);
      for (const channelId of ["bot-status-a", "bot-status-b"]) {
        const revisions = await readPanelResourceRevisions(database as unknown as D1Database, channelId);
        expect(revisions["channel.overview"]).toBeGreaterThan(0);
        expect(revisions["channel.system"]).toBeGreaterThan(0);
        expect(revisions["channel.modules"]).toBeGreaterThan(0);
      }
    } finally {
      database.close();
    }
  });

  it("revises login identity dependencies in the owner and historical member channels", async () => {
    const database = new TestD1Database();
    try {
      await addChannel(database, "identity-owner");
      await addChannel(database, "identity-member-channel");
      await database.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
         VALUES ('identity-member-channel', 'identity-owner', 'operator', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).run();
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('identity-owner', 'chat_voting', 1, '{}')`,
      ).run();
      await database.prepare(
        `INSERT INTO audit_log (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
         VALUES ('identity-audit', 'identity-owner', '2026-10-10T00:00:00.000Z', 'identity-member-channel', 'channel.updated', '{}', '{}')`,
      ).run();
      await database.prepare("DELETE FROM channel_members WHERE channel_id = 'identity-member-channel' AND user_id = 'identity-owner'").run();
      await database.prepare("DELETE FROM panel_resource_pending").run();
      await database.prepare(
        `INSERT INTO twitch_login_identity
          (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, status, created_at, updated_at)
         VALUES ('identity-owner', 'old-login', '[]', 'access', 'refresh', '2026-10-11T00:00:00.000Z', 'connected', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).run();
      const ownerBefore = await readPanelResourceRevisions(database as unknown as D1Database, "identity-owner");
      const memberBefore = await readPanelResourceRevisions(database as unknown as D1Database, "identity-member-channel");

      await database.prepare("UPDATE twitch_login_identity SET login = 'new-login' WHERE user_id = 'identity-owner'").run();

      const ownerAfter = await readPanelResourceRevisions(database as unknown as D1Database, "identity-owner");
      const memberAfter = await readPanelResourceRevisions(database as unknown as D1Database, "identity-member-channel");
      expect(ownerAfter["channel.modules"]).toBeGreaterThan(ownerBefore["channel.modules"] ?? 0);
      expect(ownerAfter["module:chat_voting:settings"]).toBeGreaterThan(ownerBefore["module:chat_voting:settings"] ?? 0);
      expect(ownerAfter["module:ads:schedule"]).toBeGreaterThan(ownerBefore["module:ads:schedule"] ?? 0);
      expect(memberAfter["channel.members"]).toBe(memberBefore["channel.members"]);
      expect(memberAfter["channel.audit"]).toBeGreaterThan(memberBefore["channel.audit"] ?? 0);
    } finally {
      database.close();
    }
  });

  it("combines D1 and channel Durable Object revision counters", async () => {
    const database = new TestD1Database();
    try {
      await addChannel(database, "revision-combined");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, created_at, updated_at)
         VALUES ('revision-combined', 'score', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).run();
      const env = {
        DB: database as unknown as D1Database,
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: () => ({ getPanelResourceRevisions: () => Promise.resolve({
            "channel.variables": 2,
            "module:ads:schedule": 3,
          }) }),
        },
      } as unknown as Env;

      await expect(readCompletePanelResourceRevisions(env, "revision-combined")).resolves.toMatchObject({
        "channel.variables": 3,
        "module:ads:schedule": 3,
      });
    } finally {
      database.close();
    }
  });

  it("declares commit triggers for every dashboard-visible source table", () => {
    const database = new TestD1Database();
    try {
      const sources = database.sqlite.prepare(
        "SELECT DISTINCT source_table FROM panel_resource_dependencies ORDER BY source_table",
      ).all() as Array<{ source_table: string }>;
      const triggers = database.sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'panel_rev_%'",
      ).all() as Array<{ sql: string }>;
      for (const { source_table: table } of sources) {
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
          expect(triggers.some(({ sql }) => new RegExp(`AFTER ${operation} ON ${table}\\b`, "iu").test(sql)),
            `${table} must revise resources after ${operation}`).toBe(true);
        }
      }
    } finally {
      database.close();
    }
  });

  it("registers every D1 table as a dashboard resource or an explicit non-panel write source", () => {
    const database = new TestD1Database();
    try {
      const dependencies = new Set((database.sqlite.prepare(
        "SELECT DISTINCT source_table FROM panel_resource_dependencies",
      ).all() as Array<{ source_table: string }>).map(({ source_table }) => source_table));
      const nonPanelTables = new Set([
        "api_source_quota",
        "auth_sessions",
        "bot_channel_status_check_locks",
        "channel_variable_stream_resets",
        "currency_rate_cache",
        "eventsub_maintenance_locks",
        "eventsub_messages",
        "oauth_transactions",
        "panel_global_resource_revisions",
        "panel_global_resource_publications",
        "panel_resource_dependencies",
        "panel_resource_pending",
        "panel_resource_revisions",
        "pending_realtime_user_revocations",
        "text_command_user_cooldowns",
        "twitch_app_access_token",
      ]);
      const tables = database.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as Array<{ name: string }>;
      const unregistered = tables.map(({ name }) => name)
        .filter((table) => !dependencies.has(table) && !nonPanelTables.has(table));
      expect(unregistered).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("declares derived variable query dependencies for module and command changes", () => {
    const database = new TestD1Database();
    try {
      const resourcesFor = (table: string): string[] => (database.sqlite.prepare(
        "SELECT resource FROM panel_resource_dependencies WHERE source_table = ? ORDER BY resource",
      ).all(table) as Array<{ resource: string }>).map(({ resource }) => resource);
      expect(resourcesFor("channel_modules")).toContain("channel.variables");
      expect(resourcesFor("text_commands")).toContain("channel.variables");
      expect(resourcesFor("channel_variables")).toContain("channel.library");
      expect(resourcesFor("overlays")).toContain("channel.variables");
      expect(resourcesFor("chat_votes")).toContain("module:chat_voting:panel");
      expect(resourcesFor("chat_vote_term_approvals")).toContain("module:chat_voting:panel");
    } finally {
      database.close();
    }
  });
});
