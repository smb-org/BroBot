import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  PanelActiveModule,
  PanelAuditEntry,
  PanelAuditResponse,
  PanelBetreiberAuditEntry,
  PanelBetreiberAuditResponse,
  PanelBetreiberKanalÜbersicht,
  PanelBetreiberMitgliederResponse,
  PanelBetreiberÜbersichtResponse,
  PanelBotPermissions,
  PanelBotStatus,
  PanelBroadcasterPermissions,
  PanelChannelOverview,
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
  PanelChannelRole,
  PanelEventOrigin,
  PanelEventTone,
} from "../../src/panel-contract";
import { MODULES } from "../../src/modules/registry";
import { TEXTBEFEHL_MINDESTSTUFEN } from "../../src/modules/textbefehle/contracts";
import type { TextbefehlArt } from "../../src/modules/textbefehle/contracts";
import { werbungModul } from "../../src/modules/werbung";
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
import type { ChannelMemberRole } from "../../src/worker/auth/authorization";
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
  role: "verwalter",
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
  id: "werbung",
  enabled: true,
  settings: JSON.stringify(werbungModul.defaultSettings),
  requiredBroadcasterScopes: ["channel:read:ads"],
  missingBroadcasterScopes: [],
};

const panelMember: PanelMember = {
  userId: "user-1",
  login: "person",
  displayName: "Person",
  profileImageUrl: null,
  role: "bediener",
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
  actorKind: "mitglied",
  createdAt: "2026-09-18T00:00:00.000Z",
  moduleId: "raid",
  action: "modul.aktiviert",
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

const panelBetreiberKanal: PanelBetreiberKanalÜbersicht = {
  channelId: "kanal-a",
  login: "kanal-a",
  displayName: "Kanal A",
  vollzustimmung: true,
  memberCounts: { broadcaster: 1, verwalter: 1, bediener: 1 },
  broadcasterConnected: true,
};

const panelBetreiberAuditEntry: PanelBetreiberAuditEntry = {
  ...panelAuditEntry,
  actorKind: "betreiber",
  channelId: "kanal-a",
};

const panelForms = {
  channelState: panelChannelState,
  channelOverview: panelChannelOverview,
  activeModule: panelActiveModule,
  moduleState: panelModuleState,
  modulesResponse: { modules: [panelModuleState] } satisfies PanelModulesResponse,
  channelsResponse: { channels: [panelChannelState], betreiber: false },
  betreiberKanal: panelBetreiberKanal,
  betreiberOverview: { channels: [panelBetreiberKanal] } satisfies PanelBetreiberÜbersichtResponse,
  betreiberMembers: {
    members: [panelMember],
    nextCursor: null,
    broadcasterCount: 1,
    viewerUserId: "user-1",
  } satisfies PanelBetreiberMitgliederResponse,
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
  betreiberAuditEntry: panelBetreiberAuditEntry,
  betreiberAuditResponse: {
    entries: [panelBetreiberAuditEntry],
    nextCursor: null,
  } satisfies PanelBetreiberAuditResponse,
  eventEntry: panelEventEntry,
  eventFilters: {
    herkunft: "modul",
    modul: "raid",
    ton: "info",
    person: "user-1",
  } satisfies PanelEventFilters,
  eventsResponse: { entries: [panelEventEntry], nextCursor: null } satisfies PanelEventsResponse,
};

const moduleActions: readonly ModuleAction[] = [
  { kind: "chat", text: "Hallo", replyToMessageId: "message-1" },
  { kind: "shoutout", zielKanalId: "kanal-b" },
  { kind: "overlay", type: "hinweis", payload: { text: "Hallo" } },
];

const moduleDiagnostic: ModuleDiagnostic = {
  code: "raid.shoutout",
  detail: { grund: "raid_erkannt", zuschauer: 5, erlaubt: true, fehlend: null },
};

const moduleActor: ModuleActor = { userId: "user-1", login: "person", role: "verwalter" };
const moduleEvent: ModuleEvent = {
  channelId: "kanal-a",
  subscriptionType: "channel.chat.message",
  subscriptionVariant: "eingehend",
  triggerId: "trigger-1",
  payload: { message_id: "message-1" },
  settings: {},
  receivedAt: "2026-09-18T00:00:00.000Z",
  actor: moduleActor,
  chatStatus: ["moderator", "abonnent"],
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
    action: "modul.aktiviert",
    before: null,
    after: { enabled: true, anzahl: 1, name: "raid" },
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
    type: "system.hallo",
    payload: {},
  } satisfies RealtimeEnvelope<"system.hallo">,
  eventLog: {
    version: 1,
    id: "message-2",
    createdAt: "2026-09-18T00:00:00.000Z",
    channelId: "kanal-a",
    type: "ereignisprotokoll.neu",
    payload: { entries: [realtimeEventLogHint] },
  } satisfies RealtimeEnvelope<"ereignisprotokoll.neu">,
  overlayPrincipal: {
    v: 1,
    kind: "overlay",
    channelId: "kanal-a",
    tokenId: "token-1",
    expiresAt: null,
  } satisfies RealtimeOverlayPrincipal,
};

const expectedModuleSettings = {
  kanalereignisse: {},
  raid: {
    shoutoutAktiv: true,
    shoutoutSchwelle: 3,
    textSchwelle: 3,
    textVoll: "Willkommen {channel}! Danke für den Raid mit {viewers} Zuschauern — schaut gerne vorbei!",
    textKlein: "Danke für den Raid, {channel}, mit {viewers} Zuschauern!",
  },
  textbefehle: {},
  werbung: {
    automatisch: "Automatische Werbepause: {duration} Sekunden. Bin gleich zurück!",
    manuell: "Werbepause: {duration} Sekunden. Bin gleich zurück!",
    vorwarnung: true,
    vorlaufSekunden: 60,
    vorwarnungText: "Werbung in {seconds} Sekunden. Bin gleich zurück!",
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

// Erschoepfungskarten: `Record<Union, true>` verlangt vom Compiler jedes Glied
// genau einmal. Fehlt eines, ist es zuviel oder heisst es anders, bricht der
// Typecheck -- lange bevor ein Client den geaenderten Wert auf der Leitung sieht.
const alleRollen: Record<ChannelMemberRole, true> = { broadcaster: true, verwalter: true, bediener: true };
const allePanelRollen: Record<PanelChannelRole, true> = { broadcaster: true, verwalter: true, bediener: true };
const alleNachrichtentypen: Record<RealtimeMessageType, true> = { "system.hallo": true, "ereignisprotokoll.neu": true };
const alleEmpfaengerarten: Record<RealtimeRecipientKind, true> = { panel: true, overlay: true };
const alleChatStatus: Record<ModuleChatStatus, true> = { zuschauer: true, abonnent: true, vip: true, moderator: true, broadcaster: true };
const alleAktionsarten: Record<ModuleAction["kind"], true> = { chat: true, shoutout: true, overlay: true };
const alleSprachen: Record<ModuleLanguage, true> = { de: true, en: true };
const alleTextbefehlArten: Record<TextbefehlArt, true> = { text: true, liste: true };
const alleEreignisherkuenfte: Record<PanelEventOrigin, true> = { kanal: true, modul: true };
const alleTonlagen: Record<PanelEventTone, true> = { info: true, hinweis: true, fehler: true };

describe("serialisierte Vertragsformen", () => {
  it("friert Schlüssel, Werte und Durable-Object-Schlüssel ein", async () => {
    const principalDatabase = new TestD1Database();
    const eventDatabase = new TestD1Database();
    try {
      await insertChannel(principalDatabase, "kanal-a");
      await insertLoginIdentityAndSession(principalDatabase, "user-1");
      await insertMember(principalDatabase, "kanal-a", "user-1", "verwalter");

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
      let eventEnvelope: RealtimeEnvelope<"ereignisprotokoll.neu"> | null = null;
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
                eventEnvelope = message as RealtimeEnvelope<"ereignisprotokoll.neu">;
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
        ...durableObjectSource.matchAll(/const (?:SECURITY_DEADLINE_KEY|WERBEVORWARNUNG_DEADLINE_KEY) = "([^"]+)"/g),
      ].map((match) => match[1]).sort();

      const wireShapes = {
        realtime: {
          ...realtimeForms,
          panelPrincipal,
          eventLogFromWorker: eventEnvelope,
        },
        panel: panelForms,
        modules: moduleForms,
      };

      expect(shapeKeys(wireShapes)).toEqual([
        "$: modules,panel,realtime",
        "$.modules: action,actor,auditEntry,diagnostic,event,mutationActor,mutationAuthorization,result",
        "$.modules.action[]: kind,replyToMessageId,text",
        "$.modules.action[]: kind,zielKanalId",
        "$.modules.action[]: kind,payload,type",
        "$.modules.action[].payload: text",
        "$.modules.actor: login,role,userId",
        "$.modules.auditEntry: action,after,before,channelId,moduleId",
        "$.modules.auditEntry.after: anzahl,enabled,name",
        "$.modules.diagnostic: code,detail",
        "$.modules.diagnostic.detail: erlaubt,fehlend,grund,zuschauer",
        "$.modules.event: actor,channelId,chatStatus,payload,receivedAt,settings,subscriptionType,subscriptionVariant,triggerId",
        "$.modules.event.actor: login,role,userId",
        "$.modules.event.payload: message_id",
        "$.modules.event.settings: ",
        "$.modules.mutationActor: sessionId,userId",
        "$.modules.mutationAuthorization: sql,values",
        "$.modules.result: actions,diagnostics",
        "$.modules.result.actions[]: kind,replyToMessageId,text",
        "$.modules.result.actions[]: kind,zielKanalId",
        "$.modules.result.actions[]: kind,payload,type",
        "$.modules.result.actions[].payload: text",
        "$.modules.result.diagnostics[]: code,detail",
        "$.modules.result.diagnostics[].detail: erlaubt,fehlend,grund,zuschauer",
        "$.panel: activeModule,auditEntry,auditResponse,betreiberAuditEntry,betreiberAuditResponse,betreiberKanal,betreiberMembers,betreiberOverview,channelOverview,channelState,channelsResponse,eventEntry,eventFilters,eventsResponse,member,membersResponse,moduleState,modulesResponse,system,twitchUser",
        "$.panel.activeModule: moduleId,settings",
        "$.panel.auditEntry: action,actorDisplayName,actorKind,actorLogin,actorUserId,after,auditId,before,createdAt,moduleId",
        "$.panel.auditResponse: entries,nextCursor",
        "$.panel.auditResponse.entries[]: action,actorDisplayName,actorKind,actorLogin,actorUserId,after,auditId,before,createdAt,moduleId",
        "$.panel.betreiberAuditEntry: action,actorDisplayName,actorKind,actorLogin,actorUserId,after,auditId,before,channelId,createdAt,moduleId",
        "$.panel.betreiberAuditResponse: entries,nextCursor",
        "$.panel.betreiberAuditResponse.entries[]: action,actorDisplayName,actorKind,actorLogin,actorUserId,after,auditId,before,channelId,createdAt,moduleId",
        "$.panel.betreiberKanal: broadcasterConnected,channelId,displayName,login,memberCounts,vollzustimmung",
        "$.panel.betreiberKanal.memberCounts: bediener,broadcaster,verwalter",
        "$.panel.betreiberMembers: broadcasterCount,members,nextCursor,viewerUserId",
        "$.panel.betreiberMembers.members[]: displayName,joinedAt,login,profileImageUrl,role,userId",
        "$.panel.betreiberOverview: channels",
        "$.panel.betreiberOverview.channels[]: broadcasterConnected,channelId,displayName,login,memberCounts,vollzustimmung",
        "$.panel.betreiberOverview.channels[].memberCounts: bediener,broadcaster,verwalter",
        "$.panel.channelOverview: activeModules,bot,botPermissions,broadcasterConnection,broadcasterPermissions,channelBotConsent,channelId,chatSubscription,displayName,lastError,login,moderator,role,tokens",
        "$.panel.channelOverview.activeModules[]: moduleId,settings",
        "$.panel.channelOverview.bot: reason,status,updatedAt",
        "$.panel.channelOverview.botPermissions: missingScopes",
        "$.panel.channelOverview.broadcasterPermissions: missingScopes",
        "$.panel.channelOverview.chatSubscription: reason,status,subscriptionId,updatedAt",
        "$.panel.channelOverview.lastError: at,message,reason,source,status,subscriptionType,subscriptionVariant",
        "$.panel.channelOverview.moderator: checkedAt,isModerator,reason",
        "$.panel.channelOverview.tokens: botExpiresAt,loginExpiresAt,loginReason,loginStatus",
        "$.panel.channelsResponse: betreiber,channels",
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
        "$.panel.eventFilters: herkunft,modul,person,ton",
        "$.panel.eventsResponse: entries,nextCursor",
        "$.panel.eventsResponse.entries[]: actorDisplayName,actorLogin,actorUserId,code,createdAt,detail,eventId,moduleId,triggerId",
        "$.panel.member: displayName,joinedAt,login,profileImageUrl,role,userId",
        "$.panel.membersResponse: broadcasterCount,members,nextCursor,viewerUserId",
        "$.panel.membersResponse.members[]: displayName,joinedAt,login,profileImageUrl,role,userId",
        "$.panel.modulesResponse: modules",
        "$.panel.modulesResponse.modules[]: enabled,id,missingBroadcasterScopes,requiredBroadcasterScopes,settings",
        "$.panel.moduleState: enabled,id,missingBroadcasterScopes,requiredBroadcasterScopes,settings",
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
      ]);
      expect(durableObjectKeys).toEqual(["sicherheitsrunde", "werbevorwarnung"]);
      expect(MODULES.map((module) => module.id).sort()).toEqual([
        "kanalereignisse",
        "raid",
        "textbefehle",
        "werbung",
      ]);
      expect(Object.fromEntries(MODULES.map((module) => [module.id, JSON.parse(JSON.stringify(module.defaultSettings))]))).toEqual(expectedModuleSettings);
      expect([...TEXTBEFEHL_MINDESTSTUFEN].sort()).toEqual(["abonnent", "alle", "broadcaster", "moderator", "vip"]);
      // Die geschlossenen Wertemengen sind reine TypeScript-Unions und haben zur
      // Laufzeit keinen Wert, den man auslesen koennte. Ein Literal gegen dasselbe
      // Literal zu pruefen waere eine Tautologie. Stattdessen zwingt ein
      // `Record<Union, true>` den Compiler, jedes Glied genau einmal zu verlangen:
      // ein neues, entferntes oder umbenanntes Glied bricht `pnpm run typecheck`,
      // und die Zusicherung darunter friert die Schreibweise ein.
      expect(Object.keys(alleRollen).sort()).toEqual(["bediener", "broadcaster", "verwalter"]);
      expect(Object.keys(allePanelRollen).sort()).toEqual(["bediener", "broadcaster", "verwalter"]);
      expect(Object.keys(alleNachrichtentypen).sort()).toEqual(["ereignisprotokoll.neu", "system.hallo"]);
      expect(Object.keys(alleEmpfaengerarten).sort()).toEqual(["overlay", "panel"]);
      expect(Object.keys(alleChatStatus).sort()).toEqual(["abonnent", "broadcaster", "moderator", "vip", "zuschauer"]);
      expect(Object.keys(alleAktionsarten).sort()).toEqual(["chat", "overlay", "shoutout"]);
      expect(Object.keys(alleSprachen).sort()).toEqual(["de", "en"]);
      expect(Object.keys(alleTextbefehlArten).sort()).toEqual(["liste", "text"]);
      expect(Object.keys(alleEreignisherkuenfte).sort()).toEqual(["kanal", "modul"]);
      expect(Object.keys(alleTonlagen).sort()).toEqual(["fehler", "hinweis", "info"]);
    } finally {
      principalDatabase.close();
      eventDatabase.close();
    }
  });
});
