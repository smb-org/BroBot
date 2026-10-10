import { z } from "zod";

import type { BotModule, ModuleExternalFetchBudget, ModuleTextBlockConditionDefinition, ModuleTemplateConditionContext, ModuleTemplateValueContext } from "../contract";
import { API_SOURCE_VALUE_VARIABLE, apiSourceModuleCatalog } from "./contracts";
import type { ApiSource } from "./contracts";
import { getApiSource, listApiSources } from "./adapters/d1";
import { fetchCachedApiSourceJson, readCachedApiSourceJson } from "./adapters/fetch-json";
import { evaluateApiSourceExpression, formatApiSourceValue, parseApiSourceName } from "./domain";
import { apiSourceRoutes } from "./routes";

const settingsSchema = z.object({});
const apiSourceIcon = { paths: ["M4 5h16v14H4z", "M7 9h10", "M7 12h6", "M7 15h8"] } as const;
const unavailableText = {
  de: apiSourceModuleCatalog.de.unavailableText,
  en: apiSourceModuleCatalog.en.unavailableText,
} as const;
const OVERLAY_REFRESH_MS = 60_000;
const MAXIMUM_EVALUATIONS_PER_RENDER = 10;
const payloadCacheByInvocation = new WeakMap<ModuleExternalFetchBudget, Map<string, Promise<unknown>>>();
const evaluationCacheByInvocation = new WeakMap<ModuleExternalFetchBudget, Map<string, Promise<unknown>>>();

const sourcePayload = (
  source: ApiSource,
  context: ModuleTemplateValueContext | ModuleTemplateConditionContext,
): Promise<unknown> => {
  if ("readOnly" in context && context.readOnly) {
    return readCachedApiSourceJson(context.DB, context.channelId, source.url, context.publicOrigin, context.now)
      .then((cached) => {
        if (cached === null) throw new Error("API source has no cached response.");
        return cached;
      });
  }
  const budget = context.externalFetchBudget;
  if (budget === undefined) {
    return fetchCachedApiSourceJson(context.DB, context.channelId, source.url, context.publicOrigin, context.now, budget);
  }
  let payloads = payloadCacheByInvocation.get(budget);
  if (payloads === undefined) {
    payloads = new Map();
    payloadCacheByInvocation.set(budget, payloads);
  }
  const cacheKey = `${context.channelId}\u0000${source.url}`;
  const cached = payloads.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = fetchCachedApiSourceJson(context.DB, context.channelId, source.url, context.publicOrigin, context.now, budget);
  payloads.set(cacheKey, pending);
  return pending;
};

const evaluateSource = (
  source: ApiSource,
  payload: unknown,
  context: ModuleTemplateValueContext | ModuleTemplateConditionContext,
): Promise<unknown> => {
  const budget = context.externalFetchBudget;
  if (budget === undefined) return evaluateApiSourceExpression(source.expression, payload);
  let evaluations = evaluationCacheByInvocation.get(budget);
  if (evaluations === undefined) {
    evaluations = new Map();
    evaluationCacheByInvocation.set(budget, evaluations);
  }
  const cacheKey = JSON.stringify([context.channelId, source.name, source.expression]);
  const cached = evaluations.get(cacheKey);
  if (cached !== undefined) return cached;
  if (evaluations.size >= MAXIMUM_EVALUATIONS_PER_RENDER) {
    return Promise.reject(new Error("API source invocation evaluation limit reached."));
  }
  const pending = evaluateApiSourceExpression(source.expression, payload);
  evaluations.set(cacheKey, pending);
  return pending;
};

const sourceConditions = async (
  db: D1Database,
  channelId: string,
): Promise<readonly ModuleTextBlockConditionDefinition[]> => {
  const sources = await listApiSources(db, channelId);
  return sources.filter(({ expression }) => expression.trim().length > 0).map(({ name }) => ({
    id: `api_source.${name}`,
    label: { de: apiSourceModuleCatalog.de.conditionLabel(name), en: apiSourceModuleCatalog.en.conditionLabel(name) },
    values: {
      true: { de: apiSourceModuleCatalog.de.trueValue, en: apiSourceModuleCatalog.en.trueValue },
      false: { de: apiSourceModuleCatalog.de.falseValue, en: apiSourceModuleCatalog.en.falseValue },
    },
  }));
};

const outputFor = async (
  name: string,
  context: ModuleTemplateValueContext | ModuleTemplateConditionContext,
): Promise<unknown> => {
  const source = await getApiSource(context.DB, context.channelId, name);
  if (source === null) throw new Error("API source was not found.");
  const payload = await sourcePayload(source, context);
  return await evaluateSource(source, payload, context);
};

const resolveConditionValues = async (
  ids: readonly string[],
  context: ModuleTemplateConditionContext,
): Promise<Readonly<Record<string, string>>> => {
  const result: Record<string, string> = {};
  const values = await Promise.all(ids.map(async (id) => {
    const name = parseApiSourceName(id);
    if (name === null) return [id, null] as const;
    const value = await outputFor(name, context);
    context.addTemplateConditionNextChangeAt?.(new Date(context.now + OVERLAY_REFRESH_MS).toISOString());
    return [id, typeof value === "boolean" ? String(value) : null] as const;
  }));
  for (const [id, value] of values) if (value !== null) result[id] = value;
  return result;
};

const resolveOverlayValues: NonNullable<BotModule<typeof settingsSchema>["resolveOverlayTemplateValues"]> = (names, context) => {
  if (!names.includes(API_SOURCE_VALUE_VARIABLE.name)) return Promise.resolve({});
  return Promise.resolve({
    [API_SOURCE_VALUE_VARIABLE.name]: {
      available: true,
      nextChangeAt: new Date(context.now + OVERLAY_REFRESH_MS).toISOString(),
    },
  });
};

export const apiSourceModule: BotModule<typeof settingsSchema> = {
  id: "api_source",
  navigationCategory: "data",
  panelIcon: apiSourceIcon,
  mandatory: true,
  mandatoryReason: {
    de: apiSourceModuleCatalog.de.mandatoryReason,
    en: apiSourceModuleCatalog.en.mandatoryReason,
  },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateVariableGroup: {
    label: { de: apiSourceModuleCatalog.de.variableGroup, en: apiSourceModuleCatalog.en.variableGroup },
    icon: apiSourceIcon,
    order: 35,
  },
  templateVariableCatalog: [API_SOURCE_VALUE_VARIABLE],
  resolveOverlayTemplateValues: resolveOverlayValues,
  templateUnavailableText: unavailableText,
  templateVariables: () => Promise.resolve([]),
  textBlockConditionsForChannel: sourceConditions,
  resolveTemplateParameter: async (name, parameter, context) => {
    if (name !== API_SOURCE_VALUE_VARIABLE.name || !/^[a-z][a-z0-9_]{0,31}$/u.test(parameter)) return null;
    try {
      const value = await outputFor(parameter, context);
      return formatApiSourceValue(value);
    } catch {
      return unavailableText[await context.channelLanguage()];
    }
  },
  resolveTemplateConditions: resolveConditionValues,
  routes: apiSourceRoutes,
  panel: () => import("./panel/index"),
};

export { API_SOURCE_MAXIMUMS, API_SOURCE_VALUE_VARIABLE } from "./contracts";
