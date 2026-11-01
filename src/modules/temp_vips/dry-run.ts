import type { DryRunEffect, DryRunEntryReport } from "../../contracts/dry-run";
import type { ModuleDryRunContext, ModuleEvent } from "../contract";
import { tempVipChatText } from "./chat-locale";
import { parseTempVipChatCommand, parseVipDuration } from "./domain";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stringValue = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const messageText = (event: ModuleEvent): string => {
  const message = record(event.payload.message);
  return typeof message?.text === "string" ? message.text : "";
};
const isModerator = (event: ModuleEvent): boolean =>
  event.chatStatus?.includes("moderator") === true || event.chatStatus?.includes("broadcaster") === true;

const rowFor = (outcome: DryRunEntryReport["outcome"], token: string): DryRunEntryReport => ({
  moduleId: "temp_vips",
  entry: { kind: "text_command", id: token.slice(1), label: token },
  outcome,
  match: { kind: "command_name", token },
  blocks: [],
  effects: [],
  templateNotes: [],
});

const withChatEffect = (
  entry: DryRunEntryReport,
  text: string,
  context: ModuleDryRunContext,
): DryRunEntryReport => {
  const effect: DryRunEffect = {
    kind: "chat",
    text,
    target: context.defaultChatTarget,
    postsTo: "this_chat",
    reply: true,
    suppressedBy: null,
    automated: false,
  };
  return { ...entry, outcome: "fires", effects: [effect] };
};

const indeterminate = (entry: DryRunEntryReport): DryRunEntryReport => ({
  ...entry,
  outcome: "indeterminate",
  templateNotes: [{ code: "template.deferred_live", detail: { name: "temp_vips.result" } }],
});

export const dryRunTempVipsChatMessage = async (
  event: ModuleEvent,
  context: ModuleDryRunContext,
): Promise<readonly DryRunEntryReport[]> => {
  if (event.subscriptionType !== "channel.chat.message") return [];
  const command = parseTempVipChatCommand(messageText(event));
  if (command === null || command.kind !== "viptime" && !isModerator(event)) return [];
  const chatterId = stringValue(event.payload.chatter_user_id);
  if (chatterId === null || chatterId === await context.botUserId?.()) return [];

  const token = `!${command.kind}`;
  const language = await context.channelLanguage();
  let entry = rowFor("fires", token);
  if (command.problem === "usage") {
    return [withChatEffect(entry, tempVipChatText(language, "usage"), context)];
  }
  if (command.kind === "vip" && command.durationToken !== null && parseVipDuration(command.durationToken) === null) {
    return [withChatEffect(entry, tempVipChatText(language, "invalidDuration"), context)];
  }

  if (command.login === null && command.kind === "viptime") return [indeterminate(entry)];
  const login = command.login;
  if (login === null) return [withChatEffect(entry, tempVipChatText(language, "usage"), context)];
  if (context.lookupUserByLogin === undefined) return [indeterminate(entry)];
  let user: Awaited<ReturnType<NonNullable<ModuleDryRunContext["lookupUserByLogin"]>>>;
  try {
    user = await context.lookupUserByLogin(login);
  } catch {
    return [indeterminate(entry)];
  }
  if (context.isUserLookupDeferred?.(login) === true) return [indeterminate(entry)];
  if (user === null) return [withChatEffect(entry, tempVipChatText(language, "unknownLogin", login), context)];
  const botUserId = await context.botUserId?.() ?? null;
  if (user.userId === event.channelId || botUserId !== null && user.userId === botUserId) {
    return [withChatEffect(entry, tempVipChatText(language, "protectedTarget"), context)];
  }

  if (command.kind === "viptime") {
    // The live row is owned by ChannelObject and is intentionally not fetched during dry-run.
    entry = indeterminate(entry);
    return [{ ...entry, templateNotes: [{ code: "template.deferred_live", detail: { name: "temp_vips.list" } }] }];
  }
  // The same command still needs the durable queue and Twitch to settle the operation result.
  return [indeterminate(entry)];
};
