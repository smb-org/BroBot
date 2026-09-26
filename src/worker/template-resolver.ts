import type { TemplateContext, TemplateVariable } from "../template";
import {
  effectiveTemplateVariables,
  parseTemplateRange,
  renderTemplate,
  templateVariableNames,
} from "../template";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../template-variables";
import { templateLanguageText } from "../modules/template-language";
import type { ModuleChannelInfo, ModuleDiagnostic, ModuleEvent, ModuleFollowedAt, ModuleLanguage, ModuleStreamState, ModuleTemplateExpansionResult } from "../modules/contract";
import { formatCount } from "../text";

export type TemplateChannelDetails = Pick<ModuleChannelInfo, "title" | "gameName" | "gameId">;
export type TemplateStreamDetails = Pick<ModuleChannelInfo, "startedAt" | "viewerCount">;

export interface TemplateResolverSources {
  streamState: () => Promise<ModuleStreamState>;
  channelDetails: () => Promise<TemplateChannelDetails | null>;
  streamDetails: () => Promise<TemplateStreamDetails | null>;
  followedAt: (userId: string) => Promise<ModuleFollowedAt>;
  followerTotal: () => Promise<number | null>;
  chattersTotal: () => Promise<number | null>;
  userCreatedAt: (userId: string) => Promise<string | null>;
  channelLanguage: () => Promise<ModuleLanguage>;
  readChannelVariables: (names: readonly string[]) => Promise<Readonly<Record<string, number>>>;
  expandModuleTemplateVariables?: (text: string, knownVariables: ReadonlySet<string>) => Promise<ModuleTemplateExpansionResult>;
  now?: () => number;
  random?: (maximumExclusive: number) => number;
}

const valueFrom = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const recordFrom = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;

const payloadString = (event: ModuleEvent, key: string): string | null => valueFrom(event.payload[key]);

const formatDuration = (start: string, now: number, language: ModuleLanguage): string => {
  const startTime = Date.parse(start);
  const minutes = Number.isFinite(startTime) ? Math.max(0, Math.floor((now - startTime) / 60_000)) : 0;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  const text = templateLanguageText[language];
  return text.duration(days > 0 ? text.day(days) : "", text.hour(hours), text.minute(remainder));
};

const daysInUtcMonth = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const utcTimeOfDay = (date: Date): number => (((date.getUTCHours() * 60 + date.getUTCMinutes()) * 60 + date.getUTCSeconds()) * 1000) + date.getUTCMilliseconds();

const durationSince = (value: string, now: number, language: ModuleLanguage): string => {
  const createdAt = Date.parse(value);
  if (!Number.isFinite(createdAt)) return "?";
  const created = new Date(createdAt);
  const current = new Date(now);
  let completedMonths = (current.getUTCFullYear() - created.getUTCFullYear()) * 12 + current.getUTCMonth() - created.getUTCMonth();
  const anniversaryDay = Math.min(created.getUTCDate(), daysInUtcMonth(current.getUTCFullYear(), current.getUTCMonth()));
  const beforeAnniversary = current.getUTCDate() < anniversaryDay ||
    current.getUTCDate() === anniversaryDay && utcTimeOfDay(current) < utcTimeOfDay(created);
  if (beforeAnniversary) completedMonths -= 1;
  completedMonths = Math.max(0, completedMonths);
  const years = Math.floor(completedMonths / 12);
  const remainingMonths = completedMonths - years * 12;
  const text = templateLanguageText[language];
  const yearsText = years > 0 ? text.year(years) : "";
  const monthsText = years === 0 || remainingMonths > 0 ? text.month(remainingMonths) : "";
  return text.elapsed(yearsText, monthsText);
};

const subageFrom = (event: ModuleEvent): number => {
  const badges = event.payload.badges;
  if (!Array.isArray(badges)) return 0;
  for (const badge of badges) {
    const record = recordFrom(badge);
    if (record?.set_id !== "subscriber" || typeof record.info !== "string") continue;
    const months = Number(record.info);
    if (Number.isSafeInteger(months) && months >= 0) return months;
  }
  return 0;
};

const secureRandomInteger = (maximumExclusive: number): number => {
  if (maximumExclusive <= 1) return 0;
  const range = 0x1_0000_0000;
  const cutoff = range - range % maximumExclusive;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= cutoff);
  return value % maximumExclusive;
};

export const createTemplateRenderer = (
  event: ModuleEvent,
  context: TemplateContext,
  moduleVariables: readonly TemplateVariable[],
  sources: TemplateResolverSources,
) => async (
  text: string,
  moduleValues: Readonly<Record<string, string | number>>,
  changed?: { name: string; value: number },
): Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[] }> => {
  const moduleExpansionVariableNames = new Set([
    ...SYSTEM_TEMPLATE_VARIABLE_LIST
      .filter((variable) => variable.contexts?.includes(context) ?? true)
      .map((variable) => variable.name),
    ...moduleVariables
      .filter((variable) => variable.contexts?.includes(context) ?? true)
      .map((variable) => variable.name),
    ...SYSTEM_TEMPLATE_VARIABLE_LIST
      .filter((variable) => variable.unavailableContextText !== undefined)
      .map((variable) => variable.name),
  ]);
  const expanded: ModuleTemplateExpansionResult = sources.expandModuleTemplateVariables === undefined
    ? { text, used: false }
    : await sources.expandModuleTemplateVariables(text, moduleExpansionVariableNames);
  const resolvedSource = expanded.text;
  const templateSource = moduleValues.legacyFallback === "true"
    ? [resolvedSource, moduleValues.offlineText, moduleValues.notFollowingText, moduleValues.unavailableText]
      .filter((value): value is string => typeof value === "string").join(" ")
    : resolvedSource;
  const names = templateVariableNames(templateSource);
  const requested = new Set(names);
  const inputFallbacks = [...SYSTEM_TEMPLATE_VARIABLE_LIST, ...moduleVariables].filter((variable) =>
    variable.unavailableContextText !== undefined &&
    !(variable.contexts?.includes(context) ?? true) &&
    requested.has(variable.name),
  );
  const legacyKind = moduleValues.legacyKind;
  if (moduleValues.legacyFallback === "true" && (legacyKind === "uptime" || legacyKind === "followage")) {
    requested.add(legacyKind);
  }
  const channelNames = [...requested]
    .flatMap((name) => name.startsWith("var.") ? [name.slice(4)] : []);
  const changedName = changed?.name;
  const namesToRead = channelNames.filter((name) => name !== changedName);
  const channelValuesPromise = namesToRead.length > 0
    ? sources.readChannelVariables(namesToRead)
    : Promise.resolve<Readonly<Record<string, number>>>({});

  const eligibleSystem = SYSTEM_TEMPLATE_VARIABLE_LIST.filter((variable) =>
    variable.contexts?.includes(context) ?? true,
  );
  const declaredSystem = eligibleSystem.filter((variable) => !moduleVariables.some((moduleVariable) => moduleVariable.name === variable.name));
  const requiredSystem = new Set([...requested].filter((name) => declaredSystem.some((variable) => variable.name === name)));
  const requiresChannelDetails = ["game", "title"].some((name) => requiredSystem.has(name));
  const requiresStreamDetails = ["uptime", "viewers"].some((name) => requiredSystem.has(name));
  const requiresLanguage = ["game", "title", "uptime", "followage", "accountage", "date", "time", "followers", "viewers", "var"].some((name) => requiredSystem.has(name)) || channelNames.length > 0 || inputFallbacks.length > 0;
  const [language, channelDetails, streamDetails, streamState, followedAt, followerTotal, chattersTotal, channelValues] = await Promise.all([
    requiresLanguage ? sources.channelLanguage() : Promise.resolve("de" as const),
    requiresChannelDetails ? sources.channelDetails() : Promise.resolve(null),
    requiresStreamDetails ? sources.streamDetails() : Promise.resolve(null),
    requiredSystem.has("live") ? sources.streamState() : Promise.resolve("unknown" as const),
    requiredSystem.has("followage") ? (() => {
      const userId = event.actor?.userId ?? payloadString(event, "chatter_user_id");
      return userId === null ? Promise.resolve("unavailable" as const) : sources.followedAt(userId);
    })() : Promise.resolve("unavailable" as const),
    requiredSystem.has("followers") ? sources.followerTotal() : Promise.resolve(null),
    requiredSystem.has("chatters") ? sources.chattersTotal() : Promise.resolve(null),
    channelValuesPromise,
  ]);

  const eventTime = Date.parse(event.receivedAt);
  const now = sources.now?.() ?? (Number.isFinite(eventTime) ? eventTime : Date.now());
  const values: Record<string, string | number> = { ...moduleValues };
  for (const variable of inputFallbacks) {
    values[variable.name] = variable.unavailableContextText === "command_input_usage"
      ? templateLanguageText[language].commandInputUsage
      : templateLanguageText[language].commandInputError;
  }
  const diagnostics: ModuleDiagnostic[] = [];
  const missing = (name: string): string => {
    diagnostics.push({ code: "template.lookup_unavailable", detail: { name } });
    return "?";
  };
  const userLogin = event.actor?.login ?? payloadString(event, "chatter_user_login") ?? "unknown";
  const displayName = payloadString(event, "chatter_user_name") ?? userLogin;
  const channelLogin = payloadString(event, "broadcaster_user_login") ?? event.channelId;
  const target = valueFrom(moduleValues.target) ?? userLogin;
  const args = valueFrom(moduleValues.args) ?? "";

  for (const name of requiredSystem) {
    if (name === "user") values[name] = userLogin;
    else if (name === "displayname") values[name] = displayName;
    else if (name === "channel") values[name] = channelLogin;
    else if (name === "target") values[name] = target;
    else if (name === "args") values[name] = args.length > 100 ? `${args.slice(0, 99)}…` : args;
    else if (name === "subage") values[name] = subageFrom(event);
    else if (name === "game") values[name] = channelDetails === null ? missing(name) : (channelDetails.gameName || "?");
    else if (name === "title") values[name] = channelDetails === null ? missing(name) : (channelDetails.title || "?");
    else if (name === "uptime") values[name] = streamDetails === null
      ? missing(name)
      : streamDetails.startedAt === null ? valueFrom(moduleValues.offlineText) ?? templateLanguageText[language].offline : formatDuration(streamDetails.startedAt, now, language);
    else if (name === "viewers") values[name] = streamDetails === null
      ? missing(name)
      : formatCount(streamDetails.startedAt === null ? 0 : streamDetails.viewerCount, language);
    else if (name === "live") values[name] = streamState === "unknown" ? missing(name) : streamState;
    else if (name === "followers") values[name] = followerTotal === null ? missing(name) : formatCount(followerTotal, language);
    else if (name === "chatters") values[name] = chattersTotal === null ? missing(name) : formatCount(chattersTotal, language);
    else if (name === "followage") {
      if (followedAt === "unavailable") {
        diagnostics.push({ code: "template.lookup_unavailable", detail: { name } });
        values[name] = valueFrom(moduleValues.unavailableText) ?? "?";
      } else if (followedAt === null) values[name] = valueFrom(moduleValues.notFollowingText) ?? templateLanguageText[language].notFollowing;
      else values[name] = durationSince(followedAt, now, language);
    } else if (name === "accountage") {
      const userId = event.actor?.userId ?? payloadString(event, "chatter_user_id");
      const createdAt = userId === null ? null : await sources.userCreatedAt(userId);
      values[name] = createdAt === null ? missing(name) : durationSince(createdAt, now, language);
    } else if (name === "date") {
      values[name] = new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
        day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin",
      }).format(now);
    } else if (name === "time") {
      values[name] = new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
        hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Berlin",
      }).format(now);
    }
  }

  const formattedChannelValues: TemplateVariable[] = Object.entries(channelValues).map(([name, value]) => ({
    name: `var.${name}`,
    group: "channel",
    maxLength: 10,
    sample: formatCount(value, language),
    source: "channel",
  }));
  const effectiveChannelVariables = new Set(formattedChannelValues.map((variable) => variable.name));
  if (changed !== undefined && requested.has(`var.${changed.name}`)) {
    values[`var.${changed.name}`] = formatCount(changed.value, language);
    effectiveChannelVariables.add(`var.${changed.name}`);
    if (!formattedChannelValues.some((variable) => variable.name === `var.${changed.name}`)) {
      formattedChannelValues.push({ name: `var.${changed.name}`, group: "channel", maxLength: 10, sample: values[`var.${changed.name}`] as string, source: "channel" });
    }
  }
  for (const [name, value] of Object.entries(channelValues)) values[`var.${name}`] = formatCount(value, language);

  const effective = effectiveTemplateVariables(context, moduleVariables, formattedChannelValues, SYSTEM_TEMPLATE_VARIABLE_LIST);
  const variableNames = new Set(effective.map((variable) => variable.name));
  for (const name of requested) {
    if (name.startsWith("var.") && !effectiveChannelVariables.has(name)) variableNames.delete(name);
  }
  const effectiveForRender = [
    ...effective.filter((variable) => variableNames.has(variable.name)),
    ...inputFallbacks.filter((variable) => requested.has(variable.name) && !variableNames.has(variable.name)),
  ];
  const randomIndex = sources.random ?? secureRandomInteger;
  const parameterValues: Record<string, (parameter: string) => string> = {
    random: (parameter) => {
      const range = parseTemplateRange(parameter || "1-100");
      if (range === null) return "{random}";
      return String(range.min + randomIndex(range.max - range.min + 1));
    },
    pick: (parameter) => {
      const choices = parameter.split("|");
      return choices[randomIndex(choices.length)]?.trim() ?? "";
    },
  };
  let renderSource = resolvedSource;
  if (moduleValues.legacyFallback === "true") {
    if (requiredSystem.has("uptime") && streamDetails?.startedAt === null) {
      renderSource = valueFrom(moduleValues.offlineText) ?? templateLanguageText[language].offline;
    } else if (requiredSystem.has("followage") && followedAt === null) {
      renderSource = valueFrom(moduleValues.notFollowingText) ?? templateLanguageText[language].notFollowing;
    } else if (requiredSystem.has("followage") && followedAt === "unavailable") {
      renderSource = valueFrom(moduleValues.unavailableText) ?? "?";
    }
  }
  const rendered = renderTemplate(renderSource, values, parameterValues, effectiveForRender);
  const outputLimit = expanded.used ? expanded.outputLimit : undefined;
  const limited = outputLimit === undefined || rendered.length <= outputLimit
    ? { text: rendered, truncated: false }
    : { text: `${rendered.slice(0, Math.max(0, outputLimit - 1))}…`, truncated: true };
  if (limited.truncated) diagnostics.push({ code: "template_truncated", detail: { current: rendered.length } });
  return { text: limited.text, diagnostics };
};
