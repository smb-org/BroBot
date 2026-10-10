import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { MODULES } from "../../src/modules/registry";
import { dashboardDataKeys, queryKeys } from "../../src/dashboard/data/keys";
import { reconcileDashboardRealtimeMessage, reconcileDashboardPanelResourceRevisions } from "../../src/dashboard/data/realtime";
import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import { authRouter } from "../../src/worker/auth/routes";
import { eventSubChannelIdForNotification, eventSubRouter } from "../../src/worker/eventsub";
import { panelRouter } from "../../src/worker/panel/routes";
import { moduleRouter } from "../../src/worker/panel/module-routes";
import { platformRouter } from "../../src/worker/platform/routes";
import { notifyCommittedResources, panelResourceChangedMessage, PANEL_RESOURCE_NOTIFIER_COVERAGE, readCompletePanelResourceRevisions, readPanelResourceRevisions } from "../../src/worker/panel-resources";
import { TestD1Database } from "./test-d1";

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const routeIsCovered = (path: string, pattern: string): boolean => {
  const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
  return path.startsWith(prefix);
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
      moduleQueryKey(id, "api_source", "sources"),
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
      dashboardDataKeys.variables(id), moduleQueryKey(id, "chat_voting", "settings"),
      moduleQueryKey(id, "text_commands", "commands"),
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
    write: async (database) => {
      await database.prepare(
        `INSERT INTO weather_cache (provider, location_key, latitude, longitude, payload_json, expires_at, updated_at)
         VALUES ('met_norway', 'test-location', 52.5, 13.4, '{}', '2026-10-10T01:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).run();
    },
  },
  {
    name: "shared API cache",
    keys: (id) => [moduleQueryKey(id, "api_source", "sources")],
    write: async (database) => {
      await database.prepare(
        `INSERT INTO api_source_cache (url_hash, payload_json, expires_at, updated_at)
         VALUES ('${"a".repeat(64)}', '{}', '2026-10-10T01:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      ).run();
    },
  },
];

describe("panel resource revisions", () => {
  it("keeps every registered mutating route and module alarm under a notifier seam", () => {
    const root = resolve(import.meta.dirname, "../..");
    const routers = [panelRouter, moduleRouter, platformRouter, authRouter, eventSubRouter];
    const mutations = routers.flatMap((router) => router.routes)
      .filter(({ method }) => writeMethods.has(method));
    expect(mutations.length).toBeGreaterThan(0);
    const routePatterns = [
      PANEL_RESOURCE_NOTIFIER_COVERAGE.channelRoutes,
      PANEL_RESOURCE_NOTIFIER_COVERAGE.platformRoutes,
      PANEL_RESOURCE_NOTIFIER_COVERAGE.authRoutes,
      PANEL_RESOURCE_NOTIFIER_COVERAGE.eventSubRoute,
    ];
    const uncovered = mutations.filter(({ path }) => !routePatterns.some((pattern) => routeIsCovered(path, pattern)));
    expect(uncovered).toEqual([]);

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
    const worker = readFileSync(resolve(root, "src/worker/index.ts"), "utf8");
    expect(worker).toContain("app.use(PANEL_RESOURCE_NOTIFIER_COVERAGE.channelRoutes");
    expect(worker).toContain("app.use(PANEL_RESOURCE_NOTIFIER_COVERAGE.platformRoutes");
    expect(worker).toMatch(/app\.use\(PANEL_RESOURCE_NOTIFIER_COVERAGE\.channelRoutes,[\s\S]*?finally \{\s*const channelId = context\.req\.param\("channelId"\);[\s\S]*?await notifyCommittedResources\(context\.env, channelId\);/u);
    expect(worker).not.toMatch(/context\.res\.status !== 401/u);
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
    expect(eventSubSource).toMatch(/finally \{\s*await notifyCommittedResources\(context\.env, revocation\.channelId\);/u);
    expect(eventSubSource).toMatch(/finally \{\s*await notifyCommittedResources\(context\.env, notifierChannelId\);/u);
    const authSource = readFileSync(resolve(root, "src/worker/auth/routes.ts"), "utf8");
    expect(authSource.match(/finally \{\s*await notifyCommittedResources\(env\);/gu) ?? []).toHaveLength(2);
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
        "panel_global_resource_publications",
        "panel_global_resource_revisions",
        "panel_resource_dependencies",
        "panel_resource_revisions",
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
