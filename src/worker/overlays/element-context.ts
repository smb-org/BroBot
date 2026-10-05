import type {
  BotModule,
  ModuleChannelInfo,
  ModuleEvent,
  ModuleLanguage,
  ModuleOverlayElementContext,
  ModuleOverlayTemplateConditions,
  ModuleOverlayTemplateValue,
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
import { readChannelLocation } from "../db/channel-settings";
import { readChannelStreamState } from "../db/stream-state";
import { helixRequest } from "../twitch/helix";
import { createTemplateRenderer, type TemplateValueProvider } from "../template-resolver";
import { createModuleExternalFetchBudget } from "../external-fetch-budget";
import { moduleBallots } from "../module-ballots";
import { createModuleSecretReadAccess } from "../module-secrets";

const moduleIsEnabled = (module: BotModule, enabled: ReadonlyMap<string, boolean>): boolean =>
  module.mandatory === true || enabled.get(module.id) === true;

/** Builds the same registered template providers used by chat, in deterministic overlay mode. */
export const createOverlayElementContext = async (
  env: Env,
  channelId: string,
  moduleId: string,
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
  let lookupFailure = false;
  let latestStreamStartedAt: string | null = stream?.state === "online" ? stream.startedAt : null;
  let streamDetailsCacheExpiresAt: number | null = null;
  let appAccessTokenPromise: Promise<string> | undefined;
  const appAccessToken = (): Promise<string> => {
    appAccessTokenPromise ??= getAppAccessToken(env, new Date(now).toISOString());
    return appAccessTokenPromise;
  };
  let streamDetailsPromise: Promise<{ startedAt: string | null; viewerCount: number } | null> | undefined;
  const cachedStreamDetails = (): Promise<{ startedAt: string | null; viewerCount: number } | null> => {
    streamDetailsPromise ??= (async () => {
      try {
        const cache = await env.CHANNEL.get(env.CHANNEL.idFromName(channelId))
          .getOverlayStreamDetails(
            stream?.state === "online" ? stream.startedAt : null,
            stream?.state === "online" ? stream.streamId : null,
            now,
          );
        if (cache === null) {
          lookupFailure = true;
          return null;
        }
        streamDetailsCacheExpiresAt = cache.expiresAt;
        if (cache.details === null) {
          lookupFailure = true;
          return null;
        }
        latestStreamStartedAt = stream?.state === "online" ? stream.startedAt ?? cache.details.startedAt : cache.details.startedAt;
        return {
          startedAt: latestStreamStartedAt,
          viewerCount: cache.details.viewerCount,
        };
      } catch {
        lookupFailure = true;
        return null;
      }
    })();
    return streamDetailsPromise;
  };
  const streamDetails = (): Promise<{ startedAt: string | null; viewerCount: number } | null> => {
    if (stream?.state === "online" && stream.startedAt !== null) {
      latestStreamStartedAt = stream.startedAt;
      return Promise.resolve({ startedAt: stream.startedAt, viewerCount: 0 });
    }
    return cachedStreamDetails();
  };
  const viewerCount = async (): Promise<number | null> => {
    return (await cachedStreamDetails())?.viewerCount ?? null;
  };
  let channelDetailsPromise: Promise<Omit<ModuleChannelInfo, "startedAt" | "viewerCount"> | null> | undefined;
  const channelDetails = (): Promise<Omit<ModuleChannelInfo, "startedAt" | "viewerCount"> | null> => {
    channelDetailsPromise ??= (async () => {
      try {
        const accessToken = await appAccessToken();
        const result = await helixRequest<{ data?: readonly Record<string, unknown>[] }>({
          url: "https://api.twitch.tv/helix/channels",
          query: { broadcaster_id: channelId },
          accessToken,
          clientId: env.TWITCH_CLIENT_ID,
        });
        const item = result.ok ? result.data.data?.[0] : undefined;
        if (item === undefined || typeof item.title !== "string" || typeof item.game_name !== "string") {
          lookupFailure = true;
          return null;
        }
        return {
          title: item.title,
          gameName: item.game_name,
          gameId: typeof item.game_id === "string" ? item.game_id : "",
        };
      } catch {
        lookupFailure = true;
        return null;
      }
    })();
    return channelDetailsPromise;
  };
  let channelInfoPromise: Promise<ModuleChannelInfo | null> | undefined;
  const channelInfo = (): Promise<ModuleChannelInfo | null> => {
    channelInfoPromise ??= (async () => {
      const [details, streamCache] = await Promise.all([channelDetails(), cachedStreamDetails()]);
      if (details === null) return null;
      const streamDetailsValue = streamCache === null ? null : await streamDetails();
      const startedAt = stream?.state === "online" ? stream.startedAt ?? streamDetailsValue?.startedAt ?? null : streamDetailsValue?.startedAt ?? null;
      latestStreamStartedAt = startedAt;
        return {
          ...details,
          startedAt,
          viewerCount: streamCache?.viewerCount ?? 0,
        };
    })();
    return channelInfoPromise;
  };

  const moduleVariables = new Map<string, ReturnType<typeof variablesForModuleTemplateContext>>();
  await Promise.all(MODULES.filter((module) => moduleIsEnabled(module, enabled)).map(async (module) => {
    let dynamic: Awaited<ReturnType<NonNullable<typeof module.templateVariables>>>;
    try {
      dynamic = await module.templateVariables?.(env.DB, channelId) ?? [];
    } catch {
      lookupFailure = true;
      dynamic = [];
    }
    const declared = [
      ...(module.templateVariableCatalog ?? []),
      ...Object.values(module.templateFields ?? {}).flatMap((variables) => (variables ?? []) as readonly TemplateVariable[]),
    ];
    moduleVariables.set(module.id, variablesForModuleTemplateContext(module, [...declared, ...dynamic]));
  }));
  const conditionsByModule = new Map(await Promise.all(MODULES.filter((module) => moduleIsEnabled(module, enabled)).map(async (module) => [
    module.id,
    [
      ...(module.textBlockConditions ?? []),
      ...(await module.textBlockConditionsForChannel?.(env.DB, channelId) ?? []),
    ],
  ] as const)));
  const templateValueProviders: TemplateValueProvider[] = MODULES.flatMap((module) => {
    if (!moduleIsEnabled(module, enabled) || (module.resolveTemplateValues === undefined && module.resolveTemplateParameter === undefined)) return [];
    return [{
      moduleId: module.id,
      ...(module.templateVariableNamespace === undefined ? {} : { templateVariableNamespace: module.templateVariableNamespace }),
      variables: moduleVariables.get(module.id) ?? [],
      textBlockConditions: conditionsByModule.get(module.id) ?? [],
      ...(module.templateUnavailableText === undefined ? {} : { templateUnavailableText: module.templateUnavailableText }),
      ...(module.resolveTemplateConditions === undefined ? {} : { resolveTemplateConditions: module.resolveTemplateConditions }),
      ...(module.dynamicTemplateVariableNames === undefined ? {} : { dynamicTemplateVariableNames: module.dynamicTemplateVariableNames }),
      ...(module.resolveOverlayTemplateValues === undefined ? {} : { resolveOverlayTemplateValues: module.resolveOverlayTemplateValues }),
      ...(module.resolveTemplateConditionTransitions === undefined ? {} : { resolveTemplateConditionTransitions: module.resolveTemplateConditionTransitions }),
      ...(module.resolveTemplateValues === undefined ? {} : { resolveTemplateValues: module.resolveTemplateValues }),
      ...(module.resolveTemplateParameter === undefined ? {} : { resolveTemplateParameter: module.resolveTemplateParameter }),
    }];
  });
  const registeredVariables = MODULES.flatMap((module) => moduleIsEnabled(module, enabled) && module.templateVariableNamespace !== "text_blocks"
    ? moduleVariables.get(module.id) ?? []
    : []);
  const conditionDefinitions: readonly ModuleTextBlockConditionDefinition[] = [...conditionsByModule.values()].flat();
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
  const externalFetchBudget = createModuleExternalFetchBudget();
  const render = createTemplateRenderer(event, "system", [], {
    DB: env.DB,
    moduleSecrets: (providerModuleId) => createModuleSecretReadAccess(env, channelId, providerModuleId),
    publicOrigin: env.PUBLIC_ORIGIN,
    externalFetchBudget,
    channelInfo,
    channelGameId: async () => (await channelDetails())?.gameId || null,
    channelTimeZone,
    channelLocation: () => readChannelLocation(env.DB, channelId),
    templateValueProviders,
    registeredTemplateVariables: [
      ...SYSTEM_TEMPLATE_VARIABLE_LIST,
      ...registeredVariables,
    ],
    streamState,
    channelDetails,
    streamDetails,
    viewerCount,
    followedAt: () => Promise.resolve("unavailable"),
    followerTotal: () => Promise.resolve(null),
    chattersTotal: () => Promise.resolve(null),
    userCreatedAt: () => Promise.resolve(null),
    channelLanguage: () => Promise.resolve(language),
    readChannelVariables: (names) => readChannelVariables(env.DB, channelId, names),
    now: () => now,
    random: () => 0,
  });
  const resolveTemplateConditions = async (ids: readonly string[]): Promise<ModuleOverlayTemplateConditions> => {
    const requested = new Set(ids);
    const values: Record<string, string> = {};
    const attributionsByCondition: Record<string, readonly string[]> = {};
    const nextChangeAt: Record<string, string> = {};
    const context: ModuleTemplateConditionContext = {
      DB: env.DB,
      channelId,
      channelTimeZone,
      channelLocation: () => readChannelLocation(env.DB, channelId),
      publicOrigin: env.PUBLIC_ORIGIN,
      externalFetchBudget,
      now,
    };
    for (const module of MODULES) {
      if (!moduleIsEnabled(module, enabled) || module.resolveTemplateConditions === undefined) continue;
      const declared = new Set((conditionsByModule.get(module.id) ?? []).map(({ id }) => id));
      const moduleIds = ids.filter((id) => requested.has(id) && declared.has(id));
      if (moduleIds.length === 0) continue;
      const moduleAttributions = new Set<string>();
      let moduleNextChangeAt: string | undefined;
      const moduleContext: ModuleTemplateConditionContext = {
        ...context,
        addTemplateValueAttribution: (text) => {
          let normalized = "";
          for (const character of text) {
            const codePoint = character.codePointAt(0) ?? 0;
            normalized += codePoint < 32 || codePoint === 127 ? " " : character;
          }
          normalized = normalized.trim();
          if (normalized.length > 0 && normalized.length <= 100) moduleAttributions.add(normalized);
        },
        addTemplateConditionNextChangeAt: (at) => { moduleNextChangeAt = at; },
      };
      try {
        const resolved = await module.resolveTemplateConditions(moduleIds, moduleContext);
        Object.assign(values, resolved);
        const attributions = [...moduleAttributions];
        for (const id of moduleIds) {
          if (typeof resolved[id] !== "string") continue;
          if (attributions.length > 0) attributionsByCondition[id] = attributions;
          if (moduleNextChangeAt !== undefined) nextChangeAt[id] = moduleNextChangeAt;
        }
      } catch {
        lookupFailure = true;
        /* Missing provider data leaves conditions unmatched. */
      }
    }
    return { values, attributionsByCondition, nextChangeAt };
  };
  const overlayValueCache = new Map<string, Promise<Readonly<Record<string, ModuleOverlayTemplateValue>>>>();
  const resolveOverlayTemplateValues = (names: readonly string[]) => {
    const key = [...new Set(names)].sort((left, right) => left.localeCompare(right)).join("\u0000");
    let pending = overlayValueCache.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const requested = new Set(names);
        const values: Record<string, ModuleOverlayTemplateValue> = {};
        for (const module of MODULES) {
          if (!moduleIsEnabled(module, enabled) || module.resolveOverlayTemplateValues === undefined) continue;
          const moduleNames = names.filter((name) => (module.dynamicTemplateVariableNames ?? []).includes(name) ||
            (moduleVariables.get(module.id) ?? []).some((variable) => variable.name === name));
          if (moduleNames.length === 0) continue;
          try {
            const resolved = await module.resolveOverlayTemplateValues(moduleNames, {
              DB: env.DB,
              channelId,
              now,
              channelTimeZone,
              channelLocation: () => readChannelLocation(env.DB, channelId),
              language,
            });
            for (const [name, value] of Object.entries(resolved)) if (requested.has(name)) values[name] = value;
          } catch {
            lookupFailure = true;
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
    streamStartedAt: () => latestStreamStartedAt,
    streamDetailsCacheExpiresAt: () => streamDetailsCacheExpiresAt,
    hasLookupFailure: () => lookupFailure,
    channelGameId: async () => (await channelDetails())?.gameId || null,
    renderTemplate: async (text, mode = "overlay") => {
      const result = await render(text, {}, undefined, mode);
      if (result.diagnostics.some(({ code }) => code === "template.lookup_unavailable")) lookupFailure = true;
      return result;
    },
    resolveTemplateConditions,
    resolveTemplateConditionTransitions: async (ids, from, until) => {
      const requested = new Set(ids);
      const transitions: ModuleTemplateConditionTransition[] = [];
      for (const module of MODULES) {
        if (!moduleIsEnabled(module, enabled) || module.resolveTemplateConditionTransitions === undefined) continue;
        const declared = new Set((module.textBlockConditions ?? []).map(({ id }) => id));
        const moduleIds = ids.filter((id) => requested.has(id) && declared.has(id));
        if (moduleIds.length === 0) continue;
        const context: ModuleTemplateConditionTimelineContext = {
          DB: env.DB,
          channelId,
          channelTimeZone,
          channelLocation: () => readChannelLocation(env.DB, channelId),
          now: from,
          until,
        };
        try { transitions.push(...await module.resolveTemplateConditionTransitions(moduleIds, context)); } catch {
          lookupFailure = true;
          /* Provider failure leaves that timeline unavailable. */
        }
      }
      return transitions.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    },
    resolveOverlayTemplateValues,
    timeDependentTemplateConditionIds,
    dynamicTemplateVariableNames,
    overlayTemplateVariableNames,
    readBallot: (ballotId) => moduleBallots(env.CHANNEL, channelId, moduleId).read(ballotId),
  };
};
