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
import { readCachedAppAccessToken } from "./app-token";
import { fetchTwitchUserByLoginWithToken } from "./shoutout";
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
  if (entries.some(({ outcome }) => outcome === "fires")) return "reacts";
  return entries.some(({ outcome }) => outcome === "indeterminate") ? "indeterminate" : "blocked";
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
  const readOnlyEnvironment = {
    DB: db,
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
    TWITCH_CLIENT_ID: env.TWITCH_CLIENT_ID,
    TOKEN_ENCRYPTION_KEYS: env.TOKEN_ENCRYPTION_KEYS,
    SESSION_ENCRYPTION_KEYS: env.SESSION_ENCRYPTION_KEYS,
  } as Env;
  let cachedAppAccessToken: Promise<string | null> | null = null;
  const deferredUserLookups = new Set<string>();
  const userLookups = new Map<string, Promise<Awaited<ReturnType<typeof fetchTwitchUserByLoginWithToken>>>>();
  const lookupUserByLogin = (login: string) => {
    const normalizedLogin = login.toLowerCase();
    const cachedLookup = userLookups.get(normalizedLogin);
    if (cachedLookup !== undefined) return cachedLookup;
    const lookup = (async () => {
      cachedAppAccessToken ??= readCachedAppAccessToken(db, readOnlyEnvironment, evaluatedAt);
      const accessToken = await cachedAppAccessToken;
      if (accessToken === null) {
        deferredUserLookups.add(normalizedLogin);
        return null;
      }
      return await fetchTwitchUserByLoginWithToken(fetcher, env.TWITCH_CLIENT_ID, login, accessToken);
    })();
    userLookups.set(normalizedLogin, lookup);
    return lookup;
  };
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
  } as const;
  const textBlockSelectionState = new Map<string, number>();
  const simulatedChannelVariables = new Map<string, number>();

  const chatModules = registry.filter((module) => (module.eventSubTypes ?? []).includes(CHAT_EVENT));
  const modules: DryRunModuleReport[] = [];

  for (const module of chatModules) {
    const dryRun = module.dryRunChatMessage as ((event: ModuleEvent, context: ModuleDryRunContext) => Promise<readonly DryRunEntryReport[]>) | undefined;
    if (dryRun === undefined) {
      modules.push(module.dryRunSilentReason === undefined
        ? { moduleId: module.id, status: "not_testable", entries: [] }
        : { moduleId: module.id, status: "silent", reasonCode: module.dryRunSilentReason, entries: [] });
      continue;
    }
    const moduleDisabled = !enabledModuleIds.has(module.id);
    const channelPaused = !moduleDisabled && dispatchState.controls.pause.active && !selectedModuleIds.has(module.id);
    const productionSelected = selectedModuleIds.has(module.id);
    const moduleTextBlockSelectionState = new Map(textBlockSelectionState);
    const moduleSimulatedChannelVariables = new Map(simulatedChannelVariables);
    // Shared-state commit boundaries mirrored from production:
    // | Kind | Production persists it when |
    // | Text-block choice | Persisted while production-selected modules render; disabled/paused modules do not run, and delivery suppression or claim release does not undo it. |
    // | Variable change | Its atomic command claim succeeds; delivery suppression does not release that claim. |
    // | Cooldown | Its claim succeeds; FAQ releases it only after a definite failed or unattempted delivery. |
    let commitsSharedState = {
      textBlockChoices: productionSelected,
      variableChanges: false,
    };
    const readSimulatedChannelVariables = async (names: readonly string[]): Promise<Readonly<Record<string, number>>> => {
      const values = await readVariables(db, channelId, names);
      return Object.fromEntries([...new Set(names)].flatMap((name) => {
        const value = moduleSimulatedChannelVariables.get(name) ?? values[name];
        return value === undefined ? [] : [[name, value]];
      }));
    };
    let moduleBallotChoiceUnresolved = false;
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
      const settings = (module.settingsReadSchema ?? module.settingsSchema).parse(rawSettings);
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
      const renderTemplate = await createSimulatedTemplateRenderer(readOnlyEnvironment, channelId, {
        event,
        templateContext: module.templateContext ?? "event",
        streamState,
        game,
        now: Date.parse(evaluatedAt),
        channelInfo,
        followedAt: () => Promise.resolve("unavailable"),
        userCreatedAt: () => Promise.resolve(null),
      }, {
        ...sharedTemplateRendererOptions,
        readChannelVariables: readSimulatedChannelVariables,
        textBlockSelectionState: moduleTextBlockSelectionState,
      });
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
          const user = await lookupUserByLogin(login);
          return user === null ? null : { userId: user.userId, login: user.login, displayName: user.displayName };
        },
        isChannelModerator: (userId) => isTwitchChannelModerator(
          readOnlyEnvironment,
          channelId,
          userId,
          fetcher,
          { refresh: "never" },
        ),
        readChannelVariables: readSimulatedChannelVariables,
        renderTemplate: (text, moduleValues, changed) => renderTemplate(text, moduleValues, changed, "chat"),
        followedAt: () => Promise.resolve("unavailable"),
        userCreatedAt: () => Promise.resolve(null),
        secureRandomInteger,
        isUserLookupDeferred: (login) => deferredUserLookups.has(login.toLowerCase()),
        markBallotChoiceUnresolved: () => { moduleBallotChoiceUnresolved = true; },
        isBallotChoiceUnresolved: () => moduleBallotChoiceUnresolved,
        ballots: moduleBallotSnapshots(
          env.CHANNEL,
          channelId,
          module.id,
        ),
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
        pointCooldownRemaining: async (moduleId, key) =>
          await channelObject?.getPointCooldownRemaining(moduleId, key) ?? 0,
      };
      const reports = await dryRun(event, context);
      const evaluatedReports = reports
        .map((entry) => withHostBlocks(entry, moduleDisabled, channelPaused))
        .map((entry) => withOutputGate(
          entry,
          module,
          event,
          channelId,
          dispatchState.controls.mute.active,
          dispatchState.controls.pause.active,
        ));
      commitsSharedState = {
        textBlockChoices: productionSelected,
        variableChanges: productionSelected && evaluatedReports.some(({ outcome, effects }) =>
          outcome === "fires" && effects.some((effect) => effect.kind === "variable"),
        ),
      };
      if (commitsSharedState.variableChanges) {
        for (const report of evaluatedReports) {
          if (report.outcome !== "fires") continue;
          for (const effect of report.effects) {
            if (effect.kind === "variable") moduleSimulatedChannelVariables.set(effect.name, effect.to);
          }
        }
      }
      if (productionSelected) {
        for (const [name, value] of moduleSimulatedChannelVariables) simulatedChannelVariables.set(name, value);
      }
      modules.push({ moduleId: module.id, status: moduleStatusFor(evaluatedReports), entries: evaluatedReports });
    } catch (error: unknown) {
      const writeBlocked = error instanceof DryRunWriteError;
      console.error("Chat dry-run module evaluation failed.", { channelId, moduleId: module.id, error });
      modules.push({
        moduleId: module.id,
        status: "error",
        entries: [],
        error: writeBlocked ? "write_blocked" : "module_error",
      });
    } finally {
      if (commitsSharedState.textBlockChoices) {
        for (const [key, index] of moduleTextBlockSelectionState) textBlockSelectionState.set(key, index);
      }
    }
  }

  const filteredModules = request.only === undefined
    ? modules
    : modules
      .filter(({ moduleId }) => moduleId === request.only?.moduleId)
      .map((module) => {
        if (request.only?.entryId === undefined) return module;
        const entries = module.entries.filter((entry) => entry.entry.id === request.only?.entryId);
        return {
          ...module,
          status: module.status === "error" ? module.status : moduleStatusFor(entries),
          entries,
        };
      });

  return {
    evaluatedAt,
    controls: { muted: dispatchState.controls.mute.active, paused: dispatchState.controls.pause.active },
    sender: { userId: syntheticUserId, resolved: false, perUserCooldownsUseSyntheticId: true },
    modules: filteredModules,
  };
};
