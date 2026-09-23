import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  PanelActiveModule,
  PanelAuditEntry,
  PanelAuditResponse,
  PanelPlatformAuditEntry,
  PanelPlatformAuditResponse,
  PanelPlatformChannelOverview,
  PanelPlatformMembersResponse,
  PanelPlatformOverviewResponse,
  PanelBotPermissions,
  PanelBotStatus,
  PanelBroadcasterPermissions,
  PanelChannelOverview,
  PanelChannelsResponse,
  PanelChannelState,
  PanelEventEntry,
  PanelEventFilters,
  PanelEventsResponse,
  PanelEventSubSubscription,
  PanelLastError,
  PanelMember,
  PanelMembersResponse,
  PanelModuleState,
  PanelModulesResponse,
  PanelModeratorStatus,
  PanelSystemResponse,
  PanelTokenStatus,
  PanelTwitchUser,
  PanelEventOrigin,
  PanelCommandAliasConflict,
} from "../../src/panel-contract";
import { MODULES } from "../../src/modules/registry";
import {
  TEXT_COMMAND_MINIMUM_TIERS,
  TEXT_COMMAND_RESPONSE_TYPES,
  TEXT_COMMAND_STREAM_CONDITIONS,
} from "../../src/modules/text_commands/contracts";
import type { TextCommandKind, TextCommandResponseType, TextCommandStreamCondition } from "../../src/modules/text_commands/contracts";
import { adsModule } from "../../src/modules/ads";
import type {
  ModuleActor,
  ModuleAction,
  ModuleDiagnostic,
  ModuleEvent,
  ModuleResult,
  ModuleChatStatus,
  ModuleLanguage,
} from "../../src/modules/contract";
import type {
  RealtimeEnvelope,
  RealtimeEventLogHint,
  RealtimeOverlayPrincipal,
  RealtimePanelPrincipal,
  RealtimeMessageType,
  RealtimeRecipientKind,
} from "../../src/realtime-contract";
import type { ChannelRole, EventTone } from "../../src/contracts/values";
import type { TextCommand } from "../../src/modules/text_commands/contracts";
import type { AdsScheduleResponse } from "../../src/modules/ads/contracts";
import type { OAuthState } from "../../src/worker/auth/oauth";
import { createSessionCookie } from "../../src/worker/auth/session";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { realtimeRouter } from "../../src/worker/realtime";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({
    active: { id: "cookie-v1", key: Buffer.alloc(32, 1).toString("base64url") },
    retired: [],
  }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({
    active: { id: "encryption-v1", key: Buffer.alloc(32, 2).toString("base64url") },
    retired: [],
  }),
};

type JsonRecord = Record<string, unknown>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shapeKeys = (value: unknown, path = "$", result: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) shapeKeys(item, `${path}[]`, result);
    return result;
  }
  if (!isJsonRecord(value)) return result;
  result.push(`${path}: ${Object.keys(value).sort().join(",")}`);
  for (const [key, nested] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    shapeKeys(nested, `${path}.${key}`, result);
  }
  return result;
};

const panelBotStatus: PanelBotStatus = {
  status: "connected",
  reason: null,
  updatedAt: "2026-09-18T00:00:00.000Z",
};

const panelModeratorStatus: PanelModeratorStatus = {
  isModerator: true,
  checkedAt: "2026-09-18T00:00:00.000Z",
  reason: null,
};

const panelBotPermissions: PanelBotPermissions = { missingScopes: ["moderator:read:followers"] };
const panelBroadcasterPermissions: PanelBroadcasterPermissions = { missingScopes: ["channel:read:ads"] };

const panelTokenStatus: PanelTokenStatus = {
  botExpiresAt: "2026-09-19T00:00:00.000Z",
  loginStatus: "connected",
  loginReason: null,
  loginExpiresAt: "2026-09-19T00:00:00.000Z",
};

const panelEventSubSubscription: PanelEventSubSubscription = {
  subscriptionType: "channel.chat.message",
  variant: "",
  version: "1",
  subscriptionId: "subscription-1",
  status: "enabled",
  reason: null,
  message: null,
  statusCode: null,
  updatedAt: "2026-09-18T00:00:00.000Z",
};

const panelLastError: PanelLastError = {
  source: "eventsub",
  reason: "network_error",
  at: "2026-09-18T00:00:00.000Z",
  message: "Twitch nicht erreichbar",
  status: 503,
  subscriptionType: "channel.chat.message",
  subscriptionVariant: "",
};

const panelChannelState: PanelChannelState = {
  channelId: "kanal-a",
  login: "kanal-a",
  displayName: "Kanal A",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: panelBotStatus,
  botPermissions: panelBotPermissions,
  broadcasterPermissions: panelBroadcasterPermissions,
  moderator: panelModeratorStatus,
  chatSubscription: {
    status: "enabled",
    subscriptionId: "subscription-1",
    reason: null,
    updatedAt: "2026-09-18T00:00:00.000Z",
  },
  tokens: panelTokenStatus,
  lastError: panelLastError,
};

const panelActiveModule: PanelActiveModule = { moduleId: "raid", settings: "{}" };
const panelChannelOverview: PanelChannelOverview = {
  ...panelChannelState,
  activeModules: [panelActiveModule],
};

const panelModuleState: PanelModuleState = {
  id: "ads",
  enabled: true,
  settings: JSON.stringify(adsModule.defaultSettings),
  requiredBroadcasterScopes: ["channel:read:ads"],
  missingBroadcasterScopes: [],
};

const panelMember: PanelMember = {
  userId: "user-1",
  login: "person",
  displayName: "Person",
  profileImageUrl: null,
  role: "operator",
  joinedAt: "2026-09-18T00:00:00.000Z",
};

const panelTwitchUser: PanelTwitchUser = {
  userId: "user-1",
  login: "person",
  displayName: "Person",
  profileImageUrl: null,
};

const panelAuditEntry: PanelAuditEntry = {
  auditId: "audit-1",
  actorUserId: "user-1",
  actorLogin: "person",
  actorDisplayName: "Person",
  actorKind: "member",
  createdAt: "2026-09-18T00:00:00.000Z",
  moduleId: "raid",
  action: "module.enabled",
  before: "null",
  after: "{}",
};

const panelEventEntry: PanelEventEntry = {
  eventId: "event-1",
  createdAt: "2026-09-18T00:00:00.000Z",
  moduleId: "raid",
  triggerId: "trigger-1",
  code: "raid.shoutout",
  detail: "{}",
  actorUserId: "user-1",
  actorLogin: "person",
  actorDisplayName: "Person",
};

const panelPlatformChannel: PanelPlatformChannelOverview = {
  channelId: "kanal-a",
  login: "kanal-a",
  displayName: "Kanal A",
  fullConsent: true,
  memberCounts: { broadcaster: 1, manager: 1, operator: 1 },
  broadcasterConnected: true,
};

const panelPlatformAuditEntry: PanelPlatformAuditEntry = {
  ...panelAuditEntry,
  actorKind: "platform_admin",
  channelId: "kanal-a",
};

const panelForms = {
  channelState: panelChannelState,
  channelOverview: panelChannelOverview,
  activeModule: panelActiveModule,
  moduleState: panelModuleState,
  modulesResponse: { modules: [panelModuleState] } satisfies PanelModulesResponse,
  channelsResponse: { channels: [panelChannelState], bot: panelBotStatus, platformAdmin: false, viewerIsBot: false } satisfies PanelChannelsResponse,
  platformChannel: panelPlatformChannel,
  platformOverview: { channels: [panelPlatformChannel] } satisfies PanelPlatformOverviewResponse,
  platformMembers: {
    members: [panelMember],
    nextCursor: null,
    broadcasterCount: 1,
    viewerUserId: "user-1",
  } satisfies PanelPlatformMembersResponse,
  member: panelMember,
  membersResponse: {
    members: [panelMember],
    nextCursor: null,
    broadcasterCount: 1,
    viewerUserId: "user-1",
  } satisfies PanelMembersResponse,
  twitchUser: panelTwitchUser,
  system: {
    broadcasterConnection: "connected",
    bot: panelBotStatus,
    botPermissions: panelBotPermissions,
    broadcasterPermissions: panelBroadcasterPermissions,
    chatSubscription: panelChannelState.chatSubscription,
    subscriptions: [panelEventSubSubscription],
    tokens: panelTokenStatus,
  } satisfies PanelSystemResponse,
  auditEntry: panelAuditEntry,
  auditResponse: { entries: [panelAuditEntry], nextCursor: null } satisfies PanelAuditResponse,
  platformAuditEntry: panelPlatformAuditEntry,
  platformAuditResponse: {
    entries: [panelPlatformAuditEntry],
    nextCursor: null,
  } satisfies PanelPlatformAuditResponse,
  eventEntry: panelEventEntry,
  eventFilters: {
    origin: "module",
    module: "raid",
    tone: "info",
    person: "user-1",
  } satisfies PanelEventFilters,
  eventsResponse: { entries: [panelEventEntry], nextCursor: null } satisfies PanelEventsResponse,
};

const moduleActions: readonly ModuleAction[] = [
  { kind: "chat", text: "Hallo", replyToMessageId: "message-1" },
  { kind: "announcement", text: "Hinweis" },
  { kind: "shoutout", targetChannelId: "kanal-b" },
  { kind: "overlay", type: "warning", payload: { text: "Hallo" } },
];

const moduleDiagnostic: ModuleDiagnostic = {
  code: "raid.shoutout",
  detail: { reason: "raid_detected", viewers: 5, allowed: true, missing: null, alias: "hi", streamState: "online" },
};

const moduleActor: ModuleActor = { userId: "user-1", login: "person", role: "manager" };
const moduleEvent: ModuleEvent = {
  channelId: "kanal-a",
  subscriptionType: "channel.chat.message",
  subscriptionVariant: "incoming",
  triggerId: "trigger-1",
  payload: { message_id: "message-1" },
  settings: {},
  receivedAt: "2026-09-18T00:00:00.000Z",
  actor: moduleActor,
  chatStatus: ["moderator", "subscriber"],
};

const moduleForms = {
  action: moduleActions,
  diagnostic: moduleDiagnostic,
  result: { actions: moduleActions, diagnostics: [moduleDiagnostic] } satisfies ModuleResult,
  actor: moduleActor,
  mutationActor: { userId: "user-1", sessionId: "session-user-1" },
  mutationAuthorization: { sql: "AND 1 = 1", values: ["kanal-a", 1, null] },
  auditEntry: {
    channelId: "kanal-a",
    moduleId: "raid",
    action: "module.enabled",
    before: null,
    after: { enabled: true, count: 1, name: "raid" },
  },
  event: moduleEvent,
};

const realtimeEventLogHint: RealtimeEventLogHint = {
  eventId: "event-1",
  createdAt: "2026-09-18T00:00:00.000Z",
  moduleId: "raid",
  code: "raid.shoutout",
  actorUserId: "user-1",
};

const realtimeForms = {
  systemHello: {
    version: 1,
    id: "message-1",
    createdAt: "2026-09-18T00:00:00.000Z",
    channelId: "kanal-a",
    type: "system.hello",
    payload: {},
  } satisfies RealtimeEnvelope<"system.hello">,
  eventLog: {
    version: 1,
    id: "message-2",
    createdAt: "2026-09-18T00:00:00.000Z",
    channelId: "kanal-a",
    type: "event_log.new",
    payload: { entries: [realtimeEventLogHint] },
  } satisfies RealtimeEnvelope<"event_log.new">,
  overlayPrincipal: {
    v: 1,
    kind: "overlay",
    channelId: "kanal-a",
    tokenId: "token-1",
    expiresAt: null,
  } satisfies RealtimeOverlayPrincipal,
};

const expectedModuleSettings = {
  channel_events: {},
  raid: {
    shoutoutEnabled: true,
    shoutoutThreshold: 3,
    textThreshold: 3,
    textLong: "Willkommen {channel}! Danke für den Raid mit {viewers} Zuschauern — schaut gerne vorbei!",
    textShort: "Danke für den Raid, {channel}, mit {viewers} Zuschauern!",
  },
  text_commands: {},
  ads: {
    automatic: "Automatische Werbepause: {duration} Sekunden. Bin gleich zurück!",
    manual: "Werbepause: {duration} Sekunden. Bin gleich zurück!",
    prewarning: true,
    leadSeconds: 60,
    prewarningText: "Werbung in {seconds} Sekunden. Bin gleich zurück!",
  },
};

const createRealtimeEnvironment = (database: TestD1Database, capture: (value: unknown) => void): Env => ({
  DB: database as unknown as D1Database,
  PUBLIC_ORIGIN: "https://brobot.example",
  ...environmentKeys,
  CHANNEL: {
    idFromName: () => "channel-object-id",
    get: () => ({
      fetch: (request: Request) => {
        const raw = request.headers.get("X-BroBot-Principal");
        capture(raw === null ? null : JSON.parse(raw));
        return Promise.resolve(new Response("ok"));
      },
    }),
  },
} as unknown as Env);

const requestForRealtime = async (userId: string): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  return new Request("https://brobot.example/ws/channels/kanal-a", {
    headers: {
      Cookie: `__Host-brobot_session=${sessionCookie}`,
      Origin: "https://brobot.example",
      "Sec-WebSocket-Protocol": "brobot.v1",
    },
  });
};

// Exhaustiveness maps: `Record<Union, true>` requires the compiler to list every member
// exactly once. If one is missing, extra, or renamed, the
// typecheck breaks -- long before a client sees the changed value on the wire.
const allRoles: Record<ChannelRole, true> = { broadcaster: true, manager: true, operator: true };
const allMessageTypes: Record<RealtimeMessageType, true> = { "system.hello": true, "event_log.new": true };
const allRecipientKinds: Record<RealtimeRecipientKind, true> = { panel: true, overlay: true };
const allChatStatus: Record<ModuleChatStatus, true> = { viewer: true, subscriber: true, vip: true, moderator: true, broadcaster: true };
const allActionKinds: Record<ModuleAction["kind"], true> = { announcement: true, chat: true, shoutout: true, overlay: true };
const allLanguages: Record<ModuleLanguage, true> = { de: true, en: true };
const allTextCommandKinds: Record<TextCommandKind, true> = { text: true, list: true };
const allTextCommandResponseTypes: Record<TextCommandResponseType, true> = { say: true, reply: true, announcement: true };
const allTextCommandStreamConditions: Record<TextCommandStreamCondition, true> = { any: true, online: true, offline: true };
const allEventOrigins: Record<PanelEventOrigin, true> = { channel: true, module: true };
const alleTonlagen: Record<EventTone, true> = { info: true, warning: true, error: true };

describe("serialized contract shapes", () => {
  it("freezes keys, values, and Durable Object keys", async () => {
    const principalDatabase = new TestD1Database();
    const eventDatabase = new TestD1Database();
    try {
      await insertChannel(principalDatabase, "kanal-a");
      await insertLoginIdentityAndSession(principalDatabase, "user-1");
      await insertMember(principalDatabase, "kanal-a", "user-1", "manager");

      let panelPrincipal: RealtimePanelPrincipal | null = null;
      const realtimeResponse = await realtimeRouter.fetch(
        await requestForRealtime("user-1"),
        createRealtimeEnvironment(principalDatabase, (value) => {
          panelPrincipal = value as RealtimePanelPrincipal;
        }),
      );
      expect(realtimeResponse.status).toBe(200);
      expect(panelPrincipal).not.toBeNull();

      await insertChannel(eventDatabase, "kanal-a");
      let eventEnvelope: RealtimeEnvelope<"event_log.new"> | null = null;
      await eventDatabase.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'probe', 1, '{}')`,
      ).run();
      const probeSchema = z.object({});
      await dispatchEventSubNotification(
        {
          DB: eventDatabase as unknown as D1Database,
          TWITCH_CLIENT_ID: "client-id",
          TWITCH_CLIENT_SECRET: "client-secret",
          CHANNEL: {
            idFromName: () => "channel-object-id",
            get: () => ({
              publish: (message: RealtimeEnvelope) => {
                eventEnvelope = message as RealtimeEnvelope<"event_log.new">;
                return Promise.resolve();
              },
            }),
          } as unknown as Env["CHANNEL"],
        },
        {
          channelId: "kanal-a",
          subscriptionType: "probe",
          triggerId: "trigger-1",
          payload: {},
          receivedAt: "2026-09-18T00:00:00.000Z",
        },
        fetch,
        [{
          id: "probe",
          settingsSchema: probeSchema,
          defaultSettings: {},
          eventSubTypes: ["probe"],
          handleEvent: () => ({ actions: [], diagnostics: [{ code: "probe.ok" }] }),
        }],
      );
      expect(eventEnvelope).not.toBeNull();

      const durableObjectSource = readFileSync(
        "src/worker/durable/ChannelObject.ts",
        "utf8",
      );
      const durableObjectKeys = [
        ...durableObjectSource.matchAll(/const (?:SECURITY_DEADLINE_KEY|AD_PREWARNING_DEADLINE_KEY) = "([^"]+)"/g),
      ].map((match) => match[1]).sort();

      // The signed OAuth state travels out to Twitch and back. It sat
      // outside this set for a long time and so silently carried a
      // German key -- exactly the blind spot this test is meant to
      // close.
      const oauthState: OAuthState = {
        transactionId: "transaktion-1",
        purpose: "login",
        expiresAt: "2026-09-21T12:00:00.000Z",
        reconcileEventSub: true,
        fullConsentSecondAttempt: true,
      };

      // The text-command shape travels through the route and into the audit log. It sat
      // outside this set and so silently carried German keys.
      const textCommand: TextCommand = {
        channelId: "kanal-a",
        name: "hallo",
        text: "Hallo {user}",
        kind: "text",
        enabled: true,
        minimumTier: "everyone",
        cooldownSeconds: 5,
        aliases: ["hi"],
        userCooldownSeconds: 30,
        streamCondition: "online",
        responseType: "announcement",
        lastUsedAt: null,
        createdAt: "2026-09-21T12:00:00.000Z",
        updatedAt: "2026-09-21T12:00:00.000Z",
      };

      // The ad schedule response goes to the panel and likewise sat
      // outside this set; it therefore silently carried German keys.
      const adsScheduleResponse: AdsScheduleResponse = {
        schedule: {
          nextAdAt: "2026-09-21T12:30:00.000Z",
          duration: 180,
          lastAdAt: "2026-09-21T12:00:00.000Z",
          prerollFreeTime: 0,
          snoozeCount: 3,
          snoozeRefreshAt: "2026-09-21T13:00:00.000Z",
        },
        recentAdBreaks: [{ timestamp: "2026-09-21T12:00:00.000Z", durationSeconds: 180 }],
        snoozeScopeAvailable: true,
      };

      const wireShapes = {
        adsScheduleResponse,
        commandAliasConflict: { field: "aliases", trigger: "hi", command: "hallo" } satisfies PanelCommandAliasConflict,
        oauthState,
        textCommand,
        realtime: {
          ...realtimeForms,
          panelPrincipal,
          eventLogFromWorker: eventEnvelope,
        },
        panel: panelForms,
        modules: moduleForms,
      };

      expect(shapeKeys(wireShapes)).toEqual([
        "$: adsScheduleResponse,commandAliasConflict,modules,oauthState,panel,realtime,textCommand",
        "$.adsScheduleResponse: recentAdBreaks,schedule,snoozeScopeAvailable",
        "$.adsScheduleResponse.recentAdBreaks[]: durationSeconds,timestamp",
        "$.adsScheduleResponse.schedule: duration,lastAdAt,nextAdAt,prerollFreeTime,snoozeCount,snoozeRefreshAt",
        "$.commandAliasConflict: command,field,trigger",
        "$.modules: action,actor,auditEntry,diagnostic,event,mutationActor,mutationAuthorization,result",
        "$.modules.action[]: kind,replyToMessageId,text",
        "$.modules.action[]: kind,text",
        "$.modules.action[]: kind,targetChannelId",
        "$.modules.action[]: kind,payload,type",
        "$.modules.action[].payload: text",
        "$.modules.actor: login,role,userId",
        "$.modules.auditEntry: action,after,before,channelId,moduleId",
        "$.modules.auditEntry.after: count,enabled,name",
        "$.modules.diagnostic: code,detail",
        "$.modules.diagnostic.detail: alias,allowed,missing,reason,streamState,viewers",
        "$.modules.event: actor,channelId,chatStatus,payload,receivedAt,settings,subscriptionType,subscriptionVariant,triggerId",
        "$.modules.event.actor: login,role,userId",
        "$.modules.event.payload: message_id",
        "$.modules.event.settings: ",
        "$.modules.mutationActor: sessionId,userId",
        "$.modules.mutationAuthorization: sql,values",
        "$.modules.result: actions,diagnostics",
        "$.modules.result.actions[]: kind,replyToMessageId,text",
        "$.modules.result.actions[]: kind,text",
        "$.modules.result.actions[]: kind,targetChannelId",
        "$.modules.result.actions[]: kind,payload,type",
        "$.modules.result.actions[].payload: text",
        "$.modules.result.diagnostics[]: code,detail",
        "$.modules.result.diagnostics[].detail: alias,allowed,missing,reason,streamState,viewers",
        "$.oauthState: expiresAt,fullConsentSecondAttempt,purpose,reconcileEventSub,transactionId",
        "$.panel: activeModule,auditEntry,auditResponse,channelOverview,channelState,channelsResponse,eventEntry,eventFilters,eventsResponse,member,membersResponse,moduleState,modulesResponse,platformAuditEntry,platformAuditResponse,platformChannel,platformMembers,platformOverview,system,twitchUser",
        "$.panel.activeModule: moduleId,settings",
        "$.panel.auditEntry: action,actorDisplayName,actorKind,actorLogin,actorUserId,after,auditId,before,createdAt,moduleId",
        "$.panel.auditResponse: entries,nextCursor",
        "$.panel.auditResponse.entries[]: action,actorDisplayName,actorKind,actorLogin,actorUserId,after,auditId,before,createdAt,moduleId",
        "$.panel.channelOverview: activeModules,bot,botPermissions,broadcasterConnection,broadcasterPermissions,channelBotConsent,channelId,chatSubscription,displayName,lastError,login,moderator,role,tokens",
        "$.panel.channelOverview.activeModules[]: moduleId,settings",
        "$.panel.channelOverview.bot: reason,status,updatedAt",
        "$.panel.channelOverview.botPermissions: missingScopes",
        "$.panel.channelOverview.broadcasterPermissions: missingScopes",
        "$.panel.channelOverview.chatSubscription: reason,status,subscriptionId,updatedAt",
        "$.panel.channelOverview.lastError: at,message,reason,source,status,subscriptionType,subscriptionVariant",
        "$.panel.channelOverview.moderator: checkedAt,isModerator,reason",
        "$.panel.channelOverview.tokens: botExpiresAt,loginExpiresAt,loginReason,loginStatus",
        "$.panel.channelsResponse: bot,channels,platformAdmin,viewerIsBot",
        "$.panel.channelsResponse.bot: reason,status,updatedAt",
        "$.panel.channelsResponse.channels[]: bot,botPermissions,broadcasterConnection,broadcasterPermissions,channelBotConsent,channelId,chatSubscription,displayName,lastError,login,moderator,role,tokens",
        "$.panel.channelsResponse.channels[].bot: reason,status,updatedAt",
        "$.panel.channelsResponse.channels[].botPermissions: missingScopes",
        "$.panel.channelsResponse.channels[].broadcasterPermissions: missingScopes",
        "$.panel.channelsResponse.channels[].chatSubscription: reason,status,subscriptionId,updatedAt",
        "$.panel.channelsResponse.channels[].lastError: at,message,reason,source,status,subscriptionType,subscriptionVariant",
        "$.panel.channelsResponse.channels[].moderator: checkedAt,isModerator,reason",
        "$.panel.channelsResponse.channels[].tokens: botExpiresAt,loginExpiresAt,loginReason,loginStatus",
        "$.panel.channelState: bot,botPermissions,broadcasterConnection,broadcasterPermissions,channelBotConsent,channelId,chatSubscription,displayName,lastError,login,moderator,role,tokens",
        "$.panel.channelState.bot: reason,status,updatedAt",
        "$.panel.channelState.botPermissions: missingScopes",
        "$.panel.channelState.broadcasterPermissions: missingScopes",
        "$.panel.channelState.chatSubscription: reason,status,subscriptionId,updatedAt",
        "$.panel.channelState.lastError: at,message,reason,source,status,subscriptionType,subscriptionVariant",
        "$.panel.channelState.moderator: checkedAt,isModerator,reason",
        "$.panel.channelState.tokens: botExpiresAt,loginExpiresAt,loginReason,loginStatus",
        "$.panel.eventEntry: actorDisplayName,actorLogin,actorUserId,code,createdAt,detail,eventId,moduleId,triggerId",
        "$.panel.eventFilters: module,origin,person,tone",
        "$.panel.eventsResponse: entries,nextCursor",
        "$.panel.eventsResponse.entries[]: actorDisplayName,actorLogin,actorUserId,code,createdAt,detail,eventId,moduleId,triggerId",
        "$.panel.member: displayName,joinedAt,login,profileImageUrl,role,userId",
        "$.panel.membersResponse: broadcasterCount,members,nextCursor,viewerUserId",
        "$.panel.membersResponse.members[]: displayName,joinedAt,login,profileImageUrl,role,userId",
        "$.panel.modulesResponse: modules",
        "$.panel.modulesResponse.modules[]: enabled,id,missingBroadcasterScopes,requiredBroadcasterScopes,settings",
        "$.panel.moduleState: enabled,id,missingBroadcasterScopes,requiredBroadcasterScopes,settings",
        "$.panel.platformAuditEntry: action,actorDisplayName,actorKind,actorLogin,actorUserId,after,auditId,before,channelId,createdAt,moduleId",
        "$.panel.platformAuditResponse: entries,nextCursor",
        "$.panel.platformAuditResponse.entries[]: action,actorDisplayName,actorKind,actorLogin,actorUserId,after,auditId,before,channelId,createdAt,moduleId",
        "$.panel.platformChannel: broadcasterConnected,channelId,displayName,fullConsent,login,memberCounts",
        "$.panel.platformChannel.memberCounts: broadcaster,manager,operator",
        "$.panel.platformMembers: broadcasterCount,members,nextCursor,viewerUserId",
        "$.panel.platformMembers.members[]: displayName,joinedAt,login,profileImageUrl,role,userId",
        "$.panel.platformOverview: channels",
        "$.panel.platformOverview.channels[]: broadcasterConnected,channelId,displayName,fullConsent,login,memberCounts",
        "$.panel.platformOverview.channels[].memberCounts: broadcaster,manager,operator",
        "$.panel.system: bot,botPermissions,broadcasterConnection,broadcasterPermissions,chatSubscription,subscriptions,tokens",
        "$.panel.system.bot: reason,status,updatedAt",
        "$.panel.system.botPermissions: missingScopes",
        "$.panel.system.broadcasterPermissions: missingScopes",
        "$.panel.system.chatSubscription: reason,status,subscriptionId,updatedAt",
        "$.panel.system.subscriptions[]: message,reason,status,statusCode,subscriptionId,subscriptionType,updatedAt,variant,version",
        "$.panel.system.tokens: botExpiresAt,loginExpiresAt,loginReason,loginStatus",
        "$.panel.twitchUser: displayName,login,profileImageUrl,userId",
        "$.realtime: eventLog,eventLogFromWorker,overlayPrincipal,panelPrincipal,systemHello",
        "$.realtime.eventLog: channelId,createdAt,id,payload,type,version",
        "$.realtime.eventLog.payload: entries",
        "$.realtime.eventLog.payload.entries[]: actorUserId,code,createdAt,eventId,moduleId",
        "$.realtime.eventLogFromWorker: channelId,createdAt,id,payload,type,version",
        "$.realtime.eventLogFromWorker.payload: entries",
        "$.realtime.eventLogFromWorker.payload.entries[]: actorUserId,code,createdAt,eventId,moduleId",
        "$.realtime.overlayPrincipal: channelId,expiresAt,kind,tokenId,v",
        "$.realtime.panelPrincipal: channelId,expiresAt,kind,role,sessionId,userId,v",
        "$.realtime.systemHello: channelId,createdAt,id,payload,type,version",
        "$.realtime.systemHello.payload: ",
        "$.textCommand: aliases,channelId,cooldownSeconds,createdAt,enabled,kind,lastUsedAt,minimumTier,name,responseType,streamCondition,text,updatedAt,userCooldownSeconds",
      ]);
      expect(durableObjectKeys).toEqual(["ad_prewarning", "security_round"]);
      expect(MODULES.map((module) => module.id).sort()).toEqual([
        "ads",
        "channel_events",
        "raid",
        "text_commands",
      ]);
      expect(Object.fromEntries(MODULES.map((module) => [module.id, JSON.parse(JSON.stringify(module.defaultSettings))]))).toEqual(expectedModuleSettings);
      expect([...TEXT_COMMAND_MINIMUM_TIERS].sort()).toEqual(["broadcaster", "everyone", "moderator", "subscriber", "vip"]);
      // The closed value sets are pure TypeScript unions and have no
      // runtime value to read. Checking a literal against the same
      // literal would be a tautology. Instead, a
      // `Record<Union, true>` forces the compiler to require every member exactly once:
      // a new, removed, or renamed member breaks `pnpm run typecheck`,
      // and the assertion below freezes the spelling.
      expect(Object.keys(allRoles).sort()).toEqual(["broadcaster", "manager", "operator"]);
      expect(Object.keys(allMessageTypes).sort()).toEqual(["event_log.new", "system.hello"]);
      expect(Object.keys(allRecipientKinds).sort()).toEqual(["overlay", "panel"]);
      expect(Object.keys(allChatStatus).sort()).toEqual(["broadcaster", "moderator", "subscriber", "viewer", "vip"]);
      expect(Object.keys(allActionKinds).sort()).toEqual(["announcement", "chat", "overlay", "shoutout"]);
      expect(Object.keys(allLanguages).sort()).toEqual(["de", "en"]);
      expect(Object.keys(allTextCommandKinds).sort()).toEqual(["list", "text"]);
      expect(Object.keys(allTextCommandResponseTypes).sort()).toEqual([...TEXT_COMMAND_RESPONSE_TYPES].sort());
      expect(Object.keys(allTextCommandStreamConditions).sort()).toEqual([...TEXT_COMMAND_STREAM_CONDITIONS].sort());
      expect(Object.keys(allEventOrigins).sort()).toEqual(["channel", "module"]);
      expect(Object.keys(alleTonlagen).sort()).toEqual(["error", "info", "warning"]);
    } finally {
      principalDatabase.close();
      eventDatabase.close();
    }
  });
});
