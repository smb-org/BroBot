import { z } from "zod";

import type { BotModule, ModuleExternalFetchBudget, ModuleTextBlockConditionDefinition, ModuleTemplateConditionContext, ModuleTemplateValueContext } from "../contract";
import { apiSourceTemplateVariable, apiSourceModuleCatalog } from "./contracts";
import type { ApiSource } from "./contracts";
import { getApiSource, listApiSources, recordApiSourceStatus } from "./adapters/d1";
import { ApiSourceFetchError, fetchCachedApiSourceResult, readCachedApiSourceJson } from "./adapters/fetch-json";
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
const payloadCacheByInvocation = new WeakMap<ModuleExternalFetchBudget, Map<string, ReturnType<typeof fetchCachedApiSourceResult>>>();
const evaluationCacheByInvocation = new WeakMap<ModuleExternalFetchBudget, Map<string, Promise<unknown>>>();

const apiSourceNameForVariable = (name: string): string | null => {
  const match = /^api\.([a-z][a-z0-9_]{0,31})$/u.exec(name);
  return match?.[1] ?? null;
};

class ApiSourceDeferredLiveError extends Error {
  public constructor() {
    super("API source has no cached response for this read-only render.");
    this.name = "ApiSourceDeferredLiveError";
  }
}

const recordFailure = async (
  source: ApiSource,
  context: ModuleTemplateValueContext | ModuleTemplateConditionContext,
  reason: "invalid_expression" | "missing_value" | ApiSourceFetchError["reason"],
  lastFetchedAt = new Date(context.now).toISOString(),
): Promise<void> => {
  if ("readOnly" in context && context.readOnly) return;
  await recordApiSourceStatus(context.DB, context.channelId, source.name, source.url, source.revision, lastFetchedAt, "error", reason);
};

const sourcePayload = (
  source: ApiSource,
  context: ModuleTemplateValueContext | ModuleTemplateConditionContext,
): Promise<unknown> => {
  if ("readOnly" in context && context.readOnly) {
    return readCachedApiSourceJson(context.DB, context.channelId, source.url, context.publicOrigin, context.now)
      .then((cached) => {
        if (cached === null) throw new ApiSourceDeferredLiveError();
        return cached;
      });
  }
  const budget = context.externalFetchBudget;
  return (async () => {
    let pending: ReturnType<typeof fetchCachedApiSourceResult>;
    if (budget === undefined) {
      pending = fetchCachedApiSourceResult(context.DB, context.channelId, source.url, context.publicOrigin, context.now, budget);
    } else {
      let payloads = payloadCacheByInvocation.get(budget);
      if (payloads === undefined) {
        payloads = new Map();
        payloadCacheByInvocation.set(budget, payloads);
      }
      const cacheKey = `${context.channelId}\u0000${source.url}`;
      pending = payloads.get(cacheKey) ?? fetchCachedApiSourceResult(
        context.DB, context.channelId, source.url, context.publicOrigin, context.now, budget,
      );
      payloads.set(cacheKey, pending);
    }
    try {
      const result = await pending;
      if (result.fetchedAt !== null) {
        await recordApiSourceStatus(context.DB, context.channelId, source.name, source.url, source.revision, result.fetchedAt, "ok", null);
      }
      return result.payload;
    } catch (failure: unknown) {
      if (failure instanceof ApiSourceFetchError && failure.fetchedAt !== null) {
        await recordFailure(source, context, failure.reason, failure.fetchedAt);
      }
      throw failure;
    }
  })();
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
  let value: unknown;
  try {
    value = await evaluateSource(source, payload, context);
  } catch (failure: unknown) {
    await recordFailure(source, context, "invalid_expression");
    throw failure;
  }
  if (value === undefined || value === null) {
    await recordFailure(source, context, "missing_value");
    throw new Error("API source expression returned no value.");
  }
  try {
    formatApiSourceValue(value);
  } catch (failure: unknown) {
    await recordFailure(source, context, "invalid_expression");
    throw failure;
  }
  return value;
};

const resolveConditionValues = async (
  ids: readonly string[],
  context: ModuleTemplateConditionContext,
): Promise<Readonly<Record<string, string>>> => {
  const result: Record<string, string> = {};
  const values = await Promise.all(ids.map(async (id) => {
    const name = parseApiSourceName(id);
    if (name === null) return [id, null] as const;
    let value: unknown;
    try {
      value = await outputFor(name, context);
    } catch (failure: unknown) {
      if (failure instanceof ApiSourceDeferredLiveError && context.readOnly === true && context.dryRun === true) {
        context.addDiagnostic?.({ code: "template.deferred_live", detail: { name: `api.${name}` } });
        return [id, null] as const;
      }
      // A failing source only makes its own condition unavailable; healthy ones still resolve.
      context.reportTemplateLookupFailure?.();
      return [id, null] as const;
    }
    context.addTemplateConditionNextChangeAt?.(new Date(context.now + OVERLAY_REFRESH_MS).toISOString());
    return [id, typeof value === "boolean" ? String(value) : null] as const;
  }));
  for (const [id, value] of values) if (value !== null) result[id] = value;
  return result;
};

const resolveOverlayValues: NonNullable<BotModule<typeof settingsSchema>["resolveOverlayTemplateValues"]> = (names, context) => {
  const values = Object.fromEntries(names.flatMap((name) => apiSourceNameForVariable(name) === null ? [] : [[name, {
      available: true,
      nextChangeAt: new Date(context.now + OVERLAY_REFRESH_MS).toISOString(),
    }]]));
  return Promise.resolve(values);
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
  templateVariableNamespace: "api_sources",
  templateVariableCatalog: [],
  resolveOverlayTemplateValues: resolveOverlayValues,
  templateUnavailableText: unavailableText,
  templateVariables: async (db, channelId) => (await listApiSources(db, channelId)).map(({ name }) => apiSourceTemplateVariable(name)),
  textBlockConditionsForChannel: sourceConditions,
  resolveTemplateValues: async (names, context) => {
    const resolved = await Promise.all(names.map(async (name) => {
      const sourceName = apiSourceNameForVariable(name);
      if (sourceName === null) return [name, null] as const;
      try {
        const value = await outputFor(sourceName, context);
        return [name, formatApiSourceValue(value)] as const;
      } catch (failure: unknown) {
        if (failure instanceof ApiSourceDeferredLiveError && "readOnly" in context && context.readOnly) {
          if ("addDiagnostic" in context) context.addDiagnostic({ code: "template.deferred_live", detail: { name } });
          return [name, null] as const;
        }
        return [name, unavailableText[await context.channelLanguage()]] as const;
      }
    }));
    return Object.fromEntries(resolved.filter((entry): entry is readonly [string, string] => entry[1] !== null));
  },
  resolveTemplateConditions: resolveConditionValues,
  routes: apiSourceRoutes,
  panel: () => import("./panel/index"),
};
