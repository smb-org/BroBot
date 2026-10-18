import type { TemplateContext, TemplateVariable } from "../template";
import type {
  ModuleChannelInfo,
  ModuleDiagnostic,
  ModuleEvent,
  ModuleExternalFetchBudget,
  ModuleFollowedAt,
  ModuleLanguage,
  ModuleRegisteredTemplateVariable,
  ModuleStreamState,
  ModuleTemplateValueContext,
} from "../modules/contract";
import { variablesForModuleTemplateContext, validateModuleTemplateVariable, templateVariableGroupForModule, MODULES } from "../modules/registry";
import { createTemplateRenderer, type TemplateValueProvider } from "./template-resolver";
import { DEFAULT_CHANNEL_TIME_ZONE } from "../modules/contract";
import { createModuleSecretReadAccess } from "./module-secrets";
import { readChannelLocation } from "./db/channel-settings";
import { readChannelVariables } from "./db/channel-variables";

export const registeredTemplateVariablesForChannel = async (
  db: D1Database,
  channelId: string,
): Promise<readonly ModuleRegisteredTemplateVariable[]> => {
  const registrations = await Promise.all(MODULES.map(async (module) => {
    const fields = Object.values(module.templateFields ?? {})
      .flatMap((variables) => variables ?? []) as TemplateVariable[];
    const dynamic = await module.templateVariables?.(db, channelId) ?? [];
    const catalog = new Map((module.templateVariableCatalog ?? []).map((variable) => [variable.name, variable]));
    const declarations = new Map<string, TemplateVariable>();
    for (const variable of [...(module.templateVariableCatalog ?? []), ...fields, ...dynamic]) {
      declarations.set(variable.name, { ...declarations.get(variable.name), ...variable });
    }
    return variablesForModuleTemplateContext(module, [...declarations.values()]).map((variable) => {
      validateModuleTemplateVariable(module, variable.name);
      const pickerGroup = templateVariableGroupForModule(module);
      const picker = variable.picker ?? catalog.get(variable.name)?.picker;
      if (module.templateVariableNamespace !== "text_blocks" && module.templateVariableGroup !== undefined &&
          (picker === undefined || pickerGroup === undefined)) {
        throw new Error(`Module template variable ${module.id}.${variable.name} is missing picker copy or source group metadata.`);
      }
      return {
        ...variable,
        ...(picker === undefined ? {} : { picker }),
        moduleId: module.id,
        isTextBlock: module.templateVariableNamespace === "text_blocks",
        availableInEventTemplates: module.resolveTemplateValues !== undefined || module.resolveTemplateParameter !== undefined,
        ...(pickerGroup === undefined ? {} : { pickerGroup }),
      };
    });
  }));
  return registrations.flat();
};

export interface SimulatedTemplateInput {
  event: ModuleEvent;
  templateContext: TemplateContext;
  streamState: ModuleStreamState;
  game: { id: string; name: string } | null;
  now: number;
  channelInfo?: ModuleChannelInfo;
  followedAt?: (userId: string) => Promise<ModuleFollowedAt>;
  userCreatedAt?: (userId: string) => Promise<string | null>;
}

export interface SimulatedTemplateRendererOptions {
  db?: D1Database;
  externalFetchBudget?: ModuleExternalFetchBudget;
  runModuleAlarm?: ModuleTemplateValueContext["runModuleAlarm"] | null;
  readOnly?: boolean;
}

/** Builds the provider stack used by template previews and read-only chat simulations. */
export const createSimulatedTemplateRenderer = async (
  env: Env,
  channelId: string,
  simulation: SimulatedTemplateInput,
  options: SimulatedTemplateRendererOptions = {},
): Promise<(
  text: string,
  moduleValues: Readonly<Record<string, string | number>>,
  changed?: { name: string; value: number },
  mode?: "chat" | "preview" | "overlay",
) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[]; attributions?: readonly string[] }>> => {
  const db = options.db ?? env.DB;
  const [registeredVariables, channelSettings, channelLanguage] = await Promise.all([
    registeredTemplateVariablesForChannel(db, channelId),
    db.prepare("SELECT time_zone FROM channels WHERE channel_id = ?").bind(channelId).first<{ time_zone: string }>(),
    db.prepare("SELECT language FROM channels WHERE channel_id = ?").bind(channelId).first<{ language: ModuleLanguage }>(),
  ]);
  const providerVariables = new Map(MODULES.map((module) => [
    module.id,
    registeredVariables.filter((variable) => variable.moduleId === module.id),
  ]));
  const providerConditions = new Map(await Promise.all(MODULES.map(async (module) => [
    module.id,
    [
      ...(module.textBlockConditions ?? []),
      ...(await module.textBlockConditionsForChannel?.(db, channelId) ?? []),
    ],
  ] as const)));
  const templateValueProviders: TemplateValueProvider[] = MODULES.flatMap((module) => {
    const resolveTemplateValues = module.resolveTemplateValues;
    if (resolveTemplateValues === undefined && module.resolveTemplateParameter === undefined) return [];
    const variables = providerVariables.get(module.id) ?? [];
    return [{
      moduleId: module.id,
      ...(module.templateVariableNamespace === undefined ? {} : { templateVariableNamespace: module.templateVariableNamespace }),
      variables,
      textBlockConditions: providerConditions.get(module.id) ?? [],
      ...(module.templateUnavailableText === undefined ? {} : { templateUnavailableText: module.templateUnavailableText }),
      ...(module.resolveTemplateConditions === undefined ? {} : { resolveTemplateConditions: module.resolveTemplateConditions }),
      ...(module.dynamicTemplateVariableNames === undefined ? {} : { dynamicTemplateVariableNames: module.dynamicTemplateVariableNames }),
      ...(module.resolveOverlayTemplateValues === undefined ? {} : { resolveOverlayTemplateValues: module.resolveOverlayTemplateValues }),
      ...(module.resolveTemplateConditionTransitions === undefined ? {} : { resolveTemplateConditionTransitions: module.resolveTemplateConditionTransitions }),
      ...(resolveTemplateValues === undefined ? {} : { resolveTemplateValues }),
      ...(module.resolveTemplateParameter === undefined ? {} : { resolveTemplateParameter: module.resolveTemplateParameter }),
    }];
  });
  const registeredTemplateVariables = registeredVariables.filter((variable) => {
    return !variable.isTextBlock &&
      (variable.contexts?.includes(simulation.templateContext) ?? true);
  });
  const channelInfo: ModuleChannelInfo = simulation.channelInfo ?? {
    title: "",
    gameName: simulation.game?.name ?? "",
    gameId: simulation.game?.id ?? "",
    startedAt: simulation.streamState === "online" ? new Date(simulation.now).toISOString() : null,
    viewerCount: 0,
  };
  const render = createTemplateRenderer(simulation.event, simulation.templateContext, [], {
    DB: db,
    moduleSecrets: (moduleId) => createModuleSecretReadAccess({ ...env, DB: db }, channelId, moduleId),
    ...(options.externalFetchBudget === undefined ? {} : { externalFetchBudget: options.externalFetchBudget }),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.runModuleAlarm == null ? {} : { runModuleAlarm: options.runModuleAlarm }),
    publicOrigin: env.PUBLIC_ORIGIN,
    channelInfo: () => Promise.resolve(channelInfo),
    channelGameId: () => Promise.resolve(simulation.game?.id ?? null),
    channelTimeZone: () => Promise.resolve(channelSettings?.time_zone ?? DEFAULT_CHANNEL_TIME_ZONE),
    channelLocation: () => readChannelLocation(db, channelId),
    templateValueProviders,
    registeredTemplateVariables,
    streamState: () => Promise.resolve(simulation.streamState),
    channelDetails: () => Promise.resolve({ title: channelInfo.title, gameName: channelInfo.gameName, gameId: channelInfo.gameId }),
    streamDetails: () => Promise.resolve({ startedAt: channelInfo.startedAt, viewerCount: channelInfo.viewerCount }),
    followedAt: simulation.followedAt ?? (() => Promise.resolve("unavailable")),
    followerTotal: () => Promise.resolve(null),
    chattersTotal: () => Promise.resolve(null),
    userCreatedAt: simulation.userCreatedAt ?? (() => Promise.resolve(null)),
    channelLanguage: () => Promise.resolve(channelLanguage?.language === "en" ? "en" : "de"),
    readChannelVariables: (names) => readChannelVariables(db, channelId, names),
    now: () => simulation.now,
  });
  return render;
};
