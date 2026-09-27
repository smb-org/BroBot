import type {
  BotModule,
  ModuleChannelInfo,
  ModuleEvent,
  ModuleLanguage,
  ModuleOverlayElementContext,
  ModuleTemplateConditionContext,
  ModuleTemplateConditionTimelineContext,
  ModuleTextBlockConditionDefinition,
  ModuleTemplateConditionTransition,
} from "../../modules/contract";
import { MODULES, variablesForModuleTemplateContext } from "../../modules/registry";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../template-variables";
import type { TemplateVariable } from "../../template";
import { getAppAccessToken } from "../app-token";
import { readChannelVariables } from "../db/channel-variables";
import { readChannelStreamState } from "../db/stream-state";
import { helixRequest } from "../twitch/helix";
import { createTemplateRenderer, type TemplateValueProvider } from "../template-resolver";

const moduleIsEnabled = (module: BotModule, enabled: ReadonlyMap<string, boolean>): boolean =>
  module.mandatory === true || enabled.get(module.id) === true;

/** Builds the same registered template providers used by chat, in deterministic overlay mode. */
export const createOverlayElementContext = async (
  env: Env,
  channelId: string,
  language: ModuleLanguage,
  now: number,
): Promise<ModuleOverlayElementContext> => {
  const [channel, stream, moduleRows] = await Promise.all([
    env.DB.prepare("SELECT login, language, time_zone FROM channels WHERE channel_id = ?")
      .bind(channelId).first<{ login: string; language: ModuleLanguage; time_zone: string }>(),
    readChannelStreamState(env.DB, channelId),
    env.DB.prepare("SELECT module_id, enabled FROM channel_modules WHERE channel_id = ?")
      .bind(channelId).all<{ module_id: string; enabled: number }>(),
  ]);
  const enabled = new Map(moduleRows.results.map(({ module_id, enabled: value }) => [module_id, value === 1]));
  const channelTimeZone = (): Promise<string> => Promise.resolve(channel?.time_zone ?? "Europe/Berlin");
  const streamState = (): Promise<"online" | "offline" | "unknown"> => Promise.resolve(stream?.state ?? "unknown");
  let channelInfoPromise: Promise<ModuleChannelInfo | null> | undefined;
  const channelInfo = (): Promise<ModuleChannelInfo | null> => {
    channelInfoPromise ??= (async () => {
      try {
        const accessToken = await getAppAccessToken(env, new Date(now).toISOString());
        const result = await helixRequest<{ data?: readonly Record<string, unknown>[] }>({
          url: "https://api.twitch.tv/helix/channels",
          query: { broadcaster_id: channelId },
          accessToken,
          clientId: env.TWITCH_CLIENT_ID,
        });
        const item = result.ok ? result.data.data?.[0] : undefined;
        if (item === undefined || typeof item.title !== "string" || typeof item.game_name !== "string") return null;
        return {
          title: item.title,
          gameName: item.game_name,
          gameId: typeof item.game_id === "string" ? item.game_id : "",
          startedAt: stream?.startedAt ?? null,
          viewerCount: 0,
        };
      } catch {
        return null;
      }
    })();
    return channelInfoPromise;
  };

  const moduleVariables = new Map<string, ReturnType<typeof variablesForModuleTemplateContext>>();
  await Promise.all(MODULES.filter((module) => moduleIsEnabled(module, enabled)).map(async (module) => {
    let dynamic: Awaited<ReturnType<NonNullable<typeof module.templateVariables>>>;
    try {
      dynamic = await module.templateVariables?.(env.DB, channelId) ?? [];
    } catch {
      dynamic = [];
    }
    const declared = Object.values(module.templateFields ?? {}).flatMap((variables) => (variables ?? []) as readonly TemplateVariable[]);
    moduleVariables.set(module.id, variablesForModuleTemplateContext(module, [...declared, ...dynamic]));
  }));
  const templateValueProviders: TemplateValueProvider[] = MODULES.flatMap((module) => {
    if (!moduleIsEnabled(module, enabled) || module.resolveTemplateValues === undefined) return [];
    return [{
      moduleId: module.id,
      ...(module.templateVariableNamespace === undefined ? {} : { templateVariableNamespace: module.templateVariableNamespace }),
      variables: moduleVariables.get(module.id) ?? [],
      ...(module.textBlockConditions === undefined ? {} : { textBlockConditions: module.textBlockConditions }),
      ...(module.templateUnavailableText === undefined ? {} : { templateUnavailableText: module.templateUnavailableText }),
      ...(module.resolveTemplateConditions === undefined ? {} : { resolveTemplateConditions: module.resolveTemplateConditions }),
      ...(module.dynamicTemplateVariableNames === undefined ? {} : { dynamicTemplateVariableNames: module.dynamicTemplateVariableNames }),
      ...(module.resolveOverlayTemplateValues === undefined ? {} : { resolveOverlayTemplateValues: module.resolveOverlayTemplateValues }),
      ...(module.resolveTemplateConditionTransitions === undefined ? {} : { resolveTemplateConditionTransitions: module.resolveTemplateConditionTransitions }),
      resolveTemplateValues: module.resolveTemplateValues,
    }];
  });
  const registeredVariables = MODULES.flatMap((module) => moduleIsEnabled(module, enabled) && module.templateVariableNamespace !== "text_blocks"
    ? moduleVariables.get(module.id) ?? []
    : []);
  const conditionDefinitions: readonly ModuleTextBlockConditionDefinition[] = MODULES
    .filter((module) => moduleIsEnabled(module, enabled))
    .flatMap((module) => module.textBlockConditions ?? []);
  const timeDependentTemplateConditionIds = new Set(conditionDefinitions
    .filter((condition) => condition.timeDependent === true)
    .map((condition) => condition.id));
  const dynamicTemplateVariableNames = new Set(MODULES
    .filter((module) => moduleIsEnabled(module, enabled))
    .flatMap((module) => module.dynamicTemplateVariableNames ?? []));
  const overlayTemplateVariableNames = new Set(MODULES
    .filter((module) => moduleIsEnabled(module, enabled) && module.resolveOverlayTemplateValues !== undefined)
    .flatMap((module) => (moduleVariables.get(module.id) ?? []).map(({ name }) => name)));
  const event: ModuleEvent = {
    channelId,
    subscriptionType: "channel.chat.message",
    triggerId: "overlay-render",
    payload: { broadcaster_user_login: channel?.login ?? channelId },
    settings: {},
    receivedAt: new Date(now).toISOString(),
    actor: null,
    chatStatus: null,
  };
  const render = createTemplateRenderer(event, "system", [], {
    DB: env.DB,
    channelInfo,
    channelGameId: async () => (await channelInfo())?.gameId || null,
    channelTimeZone,
    templateValueProviders,
    registeredTemplateVariables: [
      ...SYSTEM_TEMPLATE_VARIABLE_LIST,
      ...registeredVariables,
    ],
    streamState,
    channelDetails: async () => {
      const info = await channelInfo();
      return info === null ? null : { title: info.title, gameName: info.gameName, gameId: info.gameId };
    },
    streamDetails: () => Promise.resolve({ startedAt: stream?.startedAt ?? null, viewerCount: 0 }),
    followedAt: () => Promise.resolve("unavailable"),
    followerTotal: () => Promise.resolve(null),
    chattersTotal: () => Promise.resolve(null),
    userCreatedAt: () => Promise.resolve(null),
    channelLanguage: () => Promise.resolve(language),
    readChannelVariables: (names) => readChannelVariables(env.DB, channelId, names),
    now: () => now,
    random: () => 0,
  });
  const resolveTemplateConditions = async (ids: readonly string[]): Promise<Readonly<Record<string, string>>> => {
    const requested = new Set(ids);
    const values: Record<string, string> = {};
    const context: ModuleTemplateConditionContext = { DB: env.DB, channelId, channelTimeZone, now };
    for (const module of MODULES) {
      if (!moduleIsEnabled(module, enabled) || module.resolveTemplateConditions === undefined) continue;
      const declared = new Set((module.textBlockConditions ?? []).map(({ id }) => id));
      const moduleIds = ids.filter((id) => requested.has(id) && declared.has(id));
      if (moduleIds.length === 0) continue;
      try { Object.assign(values, await module.resolveTemplateConditions(moduleIds, context)); } catch { /* missing provider data leaves conditions unmatched */ }
    }
    return values;
  };
  const overlayValueCache = new Map<string, Promise<Readonly<Record<string, { available: boolean; targetAt?: string; targetAts?: readonly string[] }>>>>();
  const resolveOverlayTemplateValues = (names: readonly string[]) => {
    const key = [...new Set(names)].sort().join("\u0000");
    let pending = overlayValueCache.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const requested = new Set(names);
        const values: Record<string, { available: boolean; targetAt?: string; targetAts?: readonly string[] }> = {};
        for (const module of MODULES) {
          if (!moduleIsEnabled(module, enabled) || module.resolveOverlayTemplateValues === undefined) continue;
          const moduleNames = names.filter((name) => (module.dynamicTemplateVariableNames ?? []).includes(name) ||
            (moduleVariables.get(module.id) ?? []).some((variable) => variable.name === name));
          if (moduleNames.length === 0) continue;
          try {
            const resolved = await module.resolveOverlayTemplateValues(moduleNames, { DB: env.DB, channelId, now, channelTimeZone, language });
            for (const [name, value] of Object.entries(resolved)) if (requested.has(name)) values[name] = value;
          } catch {
            for (const name of moduleNames) values[name] = { available: false };
          }
        }
        return values;
      })();
      overlayValueCache.set(key, pending);
    }
    return pending;
  };
  return {
    now,
    language,
    channelTimeZone,
    streamState,
    channelGameId: async () => (await channelInfo())?.gameId || null,
    renderTemplate: (text, mode = "overlay") => render(text, {}, undefined, mode),
    resolveTemplateConditions,
    resolveTemplateConditionTransitions: async (ids, from, until) => {
      const requested = new Set(ids);
      const transitions: ModuleTemplateConditionTransition[] = [];
      for (const module of MODULES) {
        if (!moduleIsEnabled(module, enabled) || module.resolveTemplateConditionTransitions === undefined) continue;
        const declared = new Set((module.textBlockConditions ?? []).map(({ id }) => id));
        const moduleIds = ids.filter((id) => requested.has(id) && declared.has(id));
        if (moduleIds.length === 0) continue;
        const context: ModuleTemplateConditionTimelineContext = { DB: env.DB, channelId, channelTimeZone, now: from, until };
        try { transitions.push(...await module.resolveTemplateConditionTransitions(moduleIds, context)); } catch { /* provider failure leaves that timeline unavailable */ }
      }
      return transitions.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    },
    resolveOverlayTemplateValues,
    timeDependentTemplateConditionIds,
    dynamicTemplateVariableNames,
    overlayTemplateVariableNames,
  };
};
