import type {
  ModuleEvent,
  ModuleExecutionContext,
  ModuleTempVipPerson,
  ModuleTempVipResult,
  ModuleTempVipRow,
  ModuleResult,
} from "../contract";
import type { TempVipsSettings } from "./contracts";
import {
  formatTempVipAllowedDuration,
  formatTempVipExpiry,
  formatTempVipRemaining,
  resultReasonText,
  tempVipChatText,
} from "./chat-locale";
import { parseTempVipChatCommand, parseVipDuration } from "./domain";

const DAY_MS = 24 * 60 * 60_000;
const emptyResult = (): ModuleResult => ({ actions: [], diagnostics: [] });
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stringValue = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

const messageText = (event: ModuleEvent): string | null => {
  const message = record(event.payload.message);
  return typeof message?.text === "string" ? message.text : null;
};

const directChat = (event: ModuleEvent, text: string): ModuleResult => {
  const messageId = stringValue(event.payload.message_id);
  return {
    actions: [{ kind: "chat", text, automated: false, ...(messageId === null ? {} : { replyToMessageId: messageId }) }],
    diagnostics: [],
  };
};

const isModerator = (event: ModuleEvent): boolean =>
  event.chatStatus?.includes("moderator") === true || event.chatStatus?.includes("broadcaster") === true;

const personFromEvent = (event: ModuleEvent): ModuleTempVipPerson | null => {
  const userId = stringValue(event.payload.chatter_user_id);
  const login = stringValue(event.payload.chatter_user_login);
  if (userId === null || login === null) return null;
  return {
    userId,
    login: login.toLowerCase(),
    displayName: stringValue(event.payload.chatter_user_name) ?? login,
  };
};

type TargetResolution =
  | { kind: "ok"; person: ModuleTempVipPerson }
  | { kind: "unknown" }
  | { kind: "lookup_unavailable" }
  | { kind: "protected" };

const resolveTarget = async (
  login: string,
  event: ModuleEvent,
  context: ModuleExecutionContext,
): Promise<TargetResolution> => {
  if (context.lookupUserByLogin === undefined) return { kind: "lookup_unavailable" };
  let user: Awaited<ReturnType<NonNullable<ModuleExecutionContext["lookupUserByLogin"]>>>;
  try {
    user = await context.lookupUserByLogin(login);
  } catch {
    return { kind: "lookup_unavailable" };
  }
  if (user === null) return { kind: "unknown" };
  const botUserId = await context.botUserId?.() ?? null;
  if (user.userId === event.channelId || botUserId !== null && user.userId === botUserId) return { kind: "protected" };
  return { kind: "ok", person: user };
};

const targetReply = (event: ModuleEvent, login: string, resolution: TargetResolution, language: "de" | "en"): ModuleResult | null => {
  if (resolution.kind === "unknown") return directChat(event, tempVipChatText(language, "unknownLogin", login));
  if (resolution.kind === "lookup_unavailable") return directChat(event, tempVipChatText(language, "lookupUnavailable"));
  if (resolution.kind === "protected") return directChat(event, tempVipChatText(language, "protectedTarget"));
  return null;
};

const grantReply = (
  event: ModuleEvent,
  login: string,
  result: ModuleTempVipResult,
  language: "de" | "en",
  timeZone: string,
  settings: TempVipsSettings,
): ModuleResult => {
  if ((result.status === "granted" || result.status === "extended") && result.row !== undefined) {
    const expiresAt = formatTempVipExpiry(result.row.expiresAt, language, timeZone);
    return directChat(event, tempVipChatText(language, result.status, login, expiresAt));
  }
  if (result.status === "already_vip") return directChat(event, tempVipChatText(language, "alreadyVip", login));
  if (result.status === "maximum_exceeded") {
    const duration = formatTempVipAllowedDuration(result.allowedDurationMs ?? settings.maximumDurationDays * DAY_MS, language);
    return directChat(event, tempVipChatText(language, "maximumExceeded", duration));
  }
  if (result.status === "queued") return directChat(event, tempVipChatText(language, "queued", login));
  if (result.status === "rejected") return directChat(event, tempVipChatText(language, "rejected", resultReasonText(result.reason, language)));
  return directChat(event, tempVipChatText(language, "genericFailure"));
};

const resolveSelf = async (event: ModuleEvent, context: ModuleExecutionContext): Promise<TargetResolution> => {
  const person = personFromEvent(event);
  if (person === null) return { kind: "unknown" };
  const botUserId = await context.botUserId?.() ?? null;
  if (person.userId === event.channelId || person.userId === botUserId) return { kind: "protected" };
  return { kind: "ok", person };
};

const formatListReply = async (
  event: ModuleEvent,
  person: ModuleTempVipPerson,
  context: ModuleExecutionContext,
  language: "de" | "en",
): Promise<ModuleResult> => {
  let rows: ModuleTempVipRow[];
  try {
    rows = await context.tempVips.list();
  } catch {
    return directChat(event, tempVipChatText(language, "listUnavailable"));
  }
  const row = rows.find((candidate) => candidate.userId === person.userId);
  if (row === undefined) return directChat(event, tempVipChatText(language, "noActiveVip", person.login));

  const timeZone = await context.channelTimeZone();
  const expiresAt = formatTempVipExpiry(row.expiresAt, language, timeZone);
  if (row.removalFailedAt !== null) return directChat(event, tempVipChatText(language, "retryingVip", person.login, expiresAt));
  const receivedAt = Date.parse(event.receivedAt);
  const now = Number.isFinite(receivedAt) ? receivedAt : Date.now();
  if (Date.parse(row.expiresAt) <= now) return directChat(event, tempVipChatText(language, "dueVip", person.login, expiresAt));
  const remaining = formatTempVipRemaining(Date.parse(row.expiresAt) - now, language);
  return directChat(event, tempVipChatText(language, "activeVip", person.login, remaining, expiresAt));
};

export const processTempVipsChatMessage = async (
  event: ModuleEvent<TempVipsSettings>,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return emptyResult();
  const text = messageText(event);
  if (text === null) return emptyResult();
  const command = parseTempVipChatCommand(text);
  if (command === null) return emptyResult();

  const chatterId = stringValue(event.payload.chatter_user_id);
  if (chatterId === null || chatterId === await context.botUserId?.()) return emptyResult();
  if (command.kind !== "viptime" && !isModerator(event)) return emptyResult();

  const language = await context.channelLanguage();
  if (command.problem === "usage") return directChat(event, tempVipChatText(language, "usage"));
  if (command.kind === "vip" && command.durationToken !== null && parseVipDuration(command.durationToken) === null) {
    return directChat(event, tempVipChatText(language, "invalidDuration"));
  }

  if (command.kind === "viptime") {
    const target = command.login === null ? await resolveSelf(event, context) : await resolveTarget(command.login, event, context);
    if (target.kind !== "ok") return targetReply(event, command.login ?? personFromEvent(event)?.login ?? "", target, language)
      ?? directChat(event, tempVipChatText(language, "listUnavailable"));
    return await formatListReply(event, target.person, context, language);
  }

  const resolution = await resolveTarget(command.login ?? "", event, context);
  if (resolution.kind !== "ok") return targetReply(event, command.login ?? "", resolution, language)
    ?? directChat(event, tempVipChatText(language, "lookupUnavailable"));

  if (command.kind === "unvip") {
    let result: ModuleTempVipResult;
    try {
      result = await context.tempVips.end({ operationId: event.triggerId, userId: resolution.person.userId });
    } catch {
      // The operation may already be queued; never advise a blind retry.
      return directChat(event, tempVipChatText(language, "uncertainOutcome", resolution.person.login));
    }
    if (result.status === "ended") return directChat(event, tempVipChatText(language, "ended", resolution.person.login));
    if (result.status === "not_managed") return directChat(event, tempVipChatText(language, "notManaged", resolution.person.login));
    if (result.status === "queued") return directChat(event, tempVipChatText(language, "queued", resolution.person.login));
    if (result.status === "twitch_unavailable") {
      return directChat(event, tempVipChatText(language, "rejected", resultReasonText(result.reason, language)));
    }
    return directChat(event, tempVipChatText(language, "genericFailure"));
  }

  const durationMs = command.durationToken === null
    ? event.settings.defaultDurationDays * DAY_MS
    : parseVipDuration(command.durationToken);
  if (durationMs === null) return directChat(event, tempVipChatText(language, "invalidDuration"));
  const grantedByLogin = stringValue(event.payload.chatter_user_login);
  const grantedBy = grantedByLogin === null
    ? null
    : { userId: chatterId, login: grantedByLogin.toLowerCase() };
  const timeZone = await context.channelTimeZone();
  try {
    const result = await context.tempVips.grant({
      operationId: event.triggerId,
      person: resolution.person,
      grantedBy,
      durationMs,
      maximumRemainingMs: event.settings.maximumDurationDays * DAY_MS,
      source: "command",
    });
    return grantReply(event, resolution.person.login, result, language, timeZone, event.settings);
  } catch {
    return directChat(event, tempVipChatText(language, "uncertainOutcome", resolution.person.login));
  }
};
