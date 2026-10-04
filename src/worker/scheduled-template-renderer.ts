import type { ModuleChannelInfo, ModuleExternalFetchBudget, ModuleLanguage, ModuleStreamState } from "../modules/contract";
import { MODULES, validateModuleTemplateVariable, variablesForModuleTemplateContext } from "../modules/registry";
import { createTemplateRenderer, type TemplateChannelDetails, type TemplateStreamDetails, type TemplateValueProvider } from "./template-resolver";
import { readChannelLocation } from "./db/channel-settings";
import { readChannelStreamState } from "./db/stream-state";
import { readChannelVariables } from "./db/channel-variables";
import { getAppAccessToken } from "./app-token";
import { helixRequest } from "./twitch/helix";
import { DEFAULT_CHANNEL_TIME_ZONE } from "../modules/contract";
import type { TemplateVariable } from "../template";

const channelLanguage = async (db: D1Database, channelId: string): Promise<ModuleLanguage> => {
  const row = await db.prepare("SELECT language FROM channels WHERE channel_id = ?").bind(channelId).first<{ language: string }>();
  return row?.language === "en" ? "en" : "de";
};

const channelTimeZone = async (db: D1Database, channelId: string): Promise<string> => {
  const row = await db.prepare("SELECT time_zone FROM channels WHERE channel_id = ?").bind(channelId).first<{ time_zone: string }>();
  return row?.time_zone ?? DEFAULT_CHANNEL_TIME_ZONE;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Renders a scheduled text block through the normal event-context provider pipeline. */
export const renderScheduledTemplate = async (
  environment: Pick<Env, "DB" | "TWITCH_CLIENT_ID" | "TWITCH_CLIENT_SECRET" | "TOKEN_ENCRYPTION_KEYS" | "SESSION_ENCRYPTION_KEYS" | "PUBLIC_ORIGIN">,
  channelId: string,
  text: string,
  now: number,
  externalFetchBudget?: ModuleExternalFetchBudget,
  moduleValues: Readonly<Record<string, string | number>> = {},
): Promise<{ text: string; attributions?: readonly string[] }> => {
  const receivedAt = new Date(now).toISOString();
  const event = {
    channelId,
    subscriptionType: "timer",
    triggerId: "timer",
    payload: { broadcaster_user_login: channelId },
    settings: {},
    receivedAt,
    actor: null,
    chatStatus: null,
  } as const;
  const [channelState, language, timeZone, location] = await Promise.all([
    readChannelStreamState(environment.DB, channelId),
    channelLanguage(environment.DB, channelId),
    channelTimeZone(environment.DB, channelId),
    readChannelLocation(environment.DB, channelId),
  ]);
  let accessToken: Promise<string> | null = null;
  const token = (): Promise<string> => {
    accessToken ??= getAppAccessToken(environment as Env, receivedAt);
    return accessToken;
  };
  let channelDetailsPromise: Promise<TemplateChannelDetails | null> | undefined;
  const channelDetails = (): Promise<TemplateChannelDetails | null> => {
    channelDetailsPromise ??= (async () => {
      try {
        const result = await helixRequest<{ data?: unknown }>({
          url: "https://api.twitch.tv/helix/channels",
          query: { broadcaster_id: channelId },
          accessToken: await token(),
          clientId: environment.TWITCH_CLIENT_ID,
        });
        const row = result.ok && isRecord(result.data) && Array.isArray(result.data.data) && isRecord(result.data.data[0])
          ? result.data.data[0]
          : null;
        if (row === null || typeof row.title !== "string" || typeof row.game_name !== "string") return null;
        return { title: row.title, gameName: row.game_name, gameId: typeof row.game_id === "string" ? row.game_id : "" };
      } catch { return null; }
    })();
    return channelDetailsPromise;
  };
  let streamDetailsPromise: Promise<TemplateStreamDetails | null> | undefined;
  const streamDetails = (): Promise<TemplateStreamDetails | null> => {
    streamDetailsPromise ??= (async () => {
      try {
        const result = await helixRequest<{ data?: unknown }>({
          url: "https://api.twitch.tv/helix/streams",
          query: { user_id: channelId, type: "live" },
          accessToken: await token(),
          clientId: environment.TWITCH_CLIENT_ID,
        });
        if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.data)) return null;
        const row: unknown = result.data.data[0];
        if (row === undefined) return { startedAt: null, viewerCount: 0 };
        if (!isRecord(row) || typeof row.started_at !== "string") return null;
        return { startedAt: row.started_at, viewerCount: Number.isSafeInteger(row.viewer_count) ? Number(row.viewer_count) : 0 };
      } catch { return null; }
    })();
    return streamDetailsPromise;
  };
  const variablesByModule = new Map<string, ReturnType<typeof variablesForModuleTemplateContext>>();
  await Promise.all(MODULES.map(async (module) => {
    const dynamic = module.templateVariableNamespace === "text_blocks" ? [] : await module.templateVariables?.(environment.DB, channelId) ?? [];
    const fields = [
      ...(module.templateVariableCatalog ?? []),
      ...Object.values(module.templateFields ?? {}).flatMap((items) => items ?? []),
    ] as TemplateVariable[];
    const variables = variablesForModuleTemplateContext(module, [...fields, ...dynamic]);
    variables.forEach((variable) => { validateModuleTemplateVariable(module, variable.name); });
    variablesByModule.set(module.id, variables);
  }));
  const registeredTemplateVariables = MODULES
    .filter((module) => module.templateVariableNamespace !== "text_blocks")
    .flatMap((module) => variablesByModule.get(module.id) ?? []);
  const conditionsByModule = new Map(await Promise.all(MODULES.map(async (module) => [
    module.id,
    [
      ...(module.textBlockConditions ?? []),
      ...(await module.textBlockConditionsForChannel?.(environment.DB, channelId) ?? []),
    ],
  ] as const)));
  const providers: TemplateValueProvider[] = MODULES.flatMap((module) => {
    const variables = variablesByModule.get(module.id) ?? [];
    if (module.resolveTemplateValues === undefined && module.resolveTemplateParameter === undefined) return [];
    return [{
      moduleId: module.id,
      ...(module.templateVariableNamespace === undefined ? {} : { templateVariableNamespace: module.templateVariableNamespace }),
      variables,
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
  const state: ModuleStreamState = channelState?.state ?? "unknown";
  const channelInfo = async (): Promise<ModuleChannelInfo | null> => {
    const [channel, stream] = await Promise.all([channelDetails(), streamDetails()]);
    return channel === null || stream === null ? null : { ...channel, ...stream };
  };
  const render = createTemplateRenderer(event, "event", [], {
    DB: environment.DB,
    ...(externalFetchBudget === undefined ? {} : { externalFetchBudget }),
    publicOrigin: environment.PUBLIC_ORIGIN,
    channelInfo,
    channelGameId: async () => (await channelDetails())?.gameId ?? null,
    channelTimeZone: () => Promise.resolve(timeZone),
    channelLocation: () => Promise.resolve(location),
    templateValueProviders: providers,
    registeredTemplateVariables,
    streamState: () => Promise.resolve(state),
    channelDetails,
    streamDetails,
    followedAt: () => Promise.resolve("unavailable"),
    followerTotal: () => Promise.resolve(null),
    chattersTotal: () => Promise.resolve(null),
    userCreatedAt: () => Promise.resolve(null),
    channelLanguage: () => Promise.resolve(language),
    readChannelVariables: (names) => readChannelVariables(environment.DB, channelId, names),
    now: () => now,
  });
  const result = await render(text, moduleValues, undefined, "chat");
  return {
    text: result.text,
    ...(result.attributions === undefined ? {} : { attributions: result.attributions }),
  };
};
