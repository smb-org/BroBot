import type { DryRunEntryReport, DryRunModuleReport, DryRunRequest, DryRunResponse } from "../contracts/dry-run";
import type { BotModule, ModuleDryRunContext, ModuleEvent, ModuleStreamState } from "../modules/contract";
import { MODULES } from "../modules/registry";
import { getBotIdentity } from "./db/bot-identity";
import { readChannelDefaultChatTarget } from "./db/channel-settings";
import { readDispatchChannelState } from "./db/channel-controls";
import { readChannelVariables as readVariables } from "./db/channel-variables";
import { readOnlyD1, DryRunWriteError } from "./db/read-only";
import { actorForEvent, chatStatusFor, selectModulesForEvent } from "./dispatch";
import { withHostBlocks, withOutputGate } from "./dry-run-output";
import { createSimulatedTemplateRenderer } from "./simulated-template-renderer";
import { secureRandomInteger } from "./template-resolver";
import { moduleBallotSnapshots } from "./module-ballots";
import { fetchTwitchUserByLogin } from "./shoutout";
import { isTwitchChannelModerator } from "./moderation";

const CHAT_EVENT = "channel.chat.message";

export class DryRunChannelNotReleasedError extends Error {
  public constructor() {
    super("The channel is not available for dry-run requests.");
    this.name = "DryRunChannelNotReleasedError";
  }
}

const badgeForStatus: Readonly<Record<DryRunRequest["sender"]["statuses"][number], { set_id: string; id: string; info: string }>> = {
  subscriber: { set_id: "subscriber", id: "1", info: "" },
  vip: { set_id: "vip", id: "1", info: "" },
  moderator: { set_id: "moderator", id: "1", info: "" },
  broadcaster: { set_id: "broadcaster", id: "1", info: "" },
};

const moduleStatusFor = (entries: readonly DryRunEntryReport[]): DryRunModuleReport["status"] => {
  if (entries.length === 0) return "silent";
  return entries.some(({ outcome }) => outcome === "fires") ? "reacts" : "blocked";
};

export const dryRunChatMessage = async (
  env: Env,
  channelId: string,
  request: DryRunRequest,
  fetcher: typeof fetch = fetch,
  registry: readonly BotModule[] = MODULES,
): Promise<DryRunResponse> => {
  const evaluatedAt = new Date().toISOString();
  const db = readOnlyD1(env.DB);
  const channel = await db.prepare(
    "SELECT login, language, time_zone FROM channels WHERE channel_id = ?",
  ).bind(channelId).first<{ login: string; language: string; time_zone: string }>();
  if (channel === null) throw new DryRunChannelNotReleasedError();

  const [dispatchState, defaultChatTarget, botIdentity] = await Promise.all([
    readDispatchChannelState(db, channelId, evaluatedAt),
    readChannelDefaultChatTarget(db, channelId),
    getBotIdentity(db),
  ]);
  const selectedWithoutPause = selectModulesForEvent(dispatchState.activations, CHAT_EVENT, registry, false);
  const selectedByProduction = selectModulesForEvent(dispatchState.activations, CHAT_EVENT, registry, dispatchState.controls.pause.active);
  const enabledModuleIds = new Set(selectedWithoutPause.matches.map(({ module }) => module.id));
  const selectedModuleIds = new Set(selectedByProduction.matches.map(({ module }) => module.id));
  const activationByModule = new Map(dispatchState.activations.map((activation) => [activation.moduleId, activation]));

  const syntheticUserId = `dry-run:${request.sender.login}`;
  const sourceBroadcasterUserId = request.sharedChat ? `shared-chat:${channelId}` : channelId;
  const channelNamespace = Reflect.get(env, "CHANNEL") as Env["CHANNEL"] | undefined;
  const channelObject = channelNamespace?.get(channelNamespace.idFromName(channelId));
  const trackIncomingMessage = sourceBroadcasterUserId === channelId && syntheticUserId !== (botIdentity?.userId ?? null);
  const payload: Record<string, unknown> = {
    message: { text: request.text },
    message_id: "dry-run",
    chatter_user_id: syntheticUserId,
    chatter_user_login: request.sender.login,
    chatter_user_name: request.sender.login,
    broadcaster_user_login: channel.login,
    source_broadcaster_user_id: sourceBroadcasterUserId,
    badges: request.sender.statuses.map((status) => badgeForStatus[status]),
  };
  const lookedUpActor = await actorForEvent(db, channelId, payload);
  const actor = lookedUpActor === null ? null : { ...lookedUpActor, role: null };
  const chatStatus = chatStatusFor(CHAT_EVENT, payload);
  const streamState: ModuleStreamState = request.streamState;
  const game = request.game;
  const channelInfo = {
    title: "",
    gameName: game?.name ?? "",
    gameId: game?.id ?? "",
    startedAt: streamState === "online" ? evaluatedAt : null,
    viewerCount: 0,
  };
  const sharedTemplateRendererOptions = {
    db,
    externalFetchBudget: { claim: () => false },
    runModuleAlarm: null,
    readOnly: true,
    dryRun: true,
    textBlockSelectionState: new Map<string, number>(),
  } as const;

  const chatModules = registry.filter((module) => (module.eventSubTypes ?? []).includes(CHAT_EVENT));
  const modulesToReport = request.only === undefined
    ? chatModules
    : chatModules.filter((module) => module.id === request.only?.moduleId);
  const modules: DryRunModuleReport[] = [];

  for (const module of modulesToReport) {
    const dryRun = module.dryRunChatMessage as ((event: ModuleEvent, context: ModuleDryRunContext) => Promise<readonly DryRunEntryReport[]>) | undefined;
    if (dryRun === undefined) {
      modules.push(module.dryRunSilentReason === undefined
        ? { moduleId: module.id, status: "not_testable", entries: [] }
        : { moduleId: module.id, status: "silent", reasonCode: module.dryRunSilentReason, entries: [] });
      continue;
    }
    const moduleDisabled = !enabledModuleIds.has(module.id);
    const channelPaused = !moduleDisabled && dispatchState.controls.pause.active && !selectedModuleIds.has(module.id);

    try {
      const activation = activationByModule.get(module.id);
      let rawSettings: unknown = activation?.settings ?? module.defaultSettings;
      if (typeof rawSettings === "string") {
        try {
          rawSettings = JSON.parse(rawSettings) as unknown;
        } catch {
          throw new Error("Module settings contain invalid JSON.");
        }
      }
      const settings = module.settingsSchema.parse(rawSettings);
      const event: ModuleEvent = {
        channelId,
        subscriptionType: CHAT_EVENT,
        triggerId: "dry-run",
        payload,
        settings,
        receivedAt: evaluatedAt,
        eventSubTimestamp: evaluatedAt,
        actor,
        chatStatus,
      };
      const renderTemplate = await createSimulatedTemplateRenderer(env, channelId, {
        event,
        templateContext: module.templateContext ?? "event",
        streamState,
        game,
        now: Date.parse(evaluatedAt),
        channelInfo,
        followedAt: () => Promise.resolve("unavailable"),
        userCreatedAt: () => Promise.resolve(null),
      }, sharedTemplateRendererOptions);
      const context: ModuleDryRunContext = {
        DB: db,
        defaultChatTarget,
        botUserId: () => Promise.resolve(botIdentity?.userId ?? null),
        streamState: () => Promise.resolve(streamState),
        channelInfo: () => Promise.resolve(channelInfo),
        channelGameId: () => Promise.resolve(game?.id ?? null),
        channelLanguage: () => Promise.resolve(channel.language === "en" ? "en" : "de"),
        channelTimeZone: () => Promise.resolve(channel.time_zone),
        lookupUserByLogin: async (login) => {
          const user = await fetchTwitchUserByLogin(fetcher, env, login, "app");
          return user === null ? null : { userId: user.userId, login: user.login, displayName: user.displayName };
        },
        isChannelModerator: (userId) => isTwitchChannelModerator(env, channelId, userId, fetcher),
        readChannelVariables: (names) => readVariables(db, channelId, names),
        renderTemplate: (text, moduleValues, changed) => renderTemplate(text, moduleValues, changed, "chat"),
        followedAt: () => Promise.resolve("unavailable"),
        userCreatedAt: () => Promise.resolve(null),
        secureRandomInteger,
        ballots: moduleBallotSnapshots(env.CHANNEL, channelId, module.id),
        activeChatters: {
          count: async (windowMs) => {
            const count = await channelObject?.getActiveChatterCountSnapshot(windowMs) ?? 0;
            if (!trackIncomingMessage) return count;
            const existing = await channelObject?.getActiveChatterSnapshot(syntheticUserId) ?? null;
            return existing === null ? count + 1 : count;
          },
          seen: async (userId) => {
            const existing = await channelObject?.getActiveChatterSnapshot(userId) ?? null;
            if (existing !== null || !trackIncomingMessage || userId !== syntheticUserId) return existing;
            return { firstSeenAt: evaluatedAt, lastSeenAt: evaluatedAt };
          },
        },
      };
      const reports = await dryRun(event, context);
      const filtered = request.only?.entryId === undefined
        ? reports
        : reports.filter((entry) => entry.entry.id === request.only?.entryId);
      const entries = filtered
        .map((entry) => withHostBlocks(entry, moduleDisabled, channelPaused))
        .map((entry) => withOutputGate(
          entry,
          module,
          event,
          channelId,
          dispatchState.controls.mute.active,
          dispatchState.controls.pause.active,
        ));
      modules.push({ moduleId: module.id, status: moduleStatusFor(entries), entries });
    } catch (error: unknown) {
      const writeBlocked = error instanceof DryRunWriteError;
      console.error("Chat dry-run module evaluation failed.", { channelId, moduleId: module.id, error });
      modules.push({
        moduleId: module.id,
        status: "error",
        entries: [],
        error: writeBlocked ? "write_blocked" : "module_error",
      });
    }
  }

  return {
    evaluatedAt,
    controls: { muted: dispatchState.controls.mute.active, paused: dispatchState.controls.pause.active },
    sender: { userId: syntheticUserId, resolved: false, perUserCooldownsUseSyntheticId: true },
    modules,
  };
};
