import type { EventCode } from "../../contracts/values";
import { CHANNEL_VARIABLE_MAXIMUM_VALUE, CHANNEL_VARIABLE_MINIMUM_VALUE } from "../../contracts/values";
import { effectiveTemplateVariables, renderTemplate, SYSTEM_TEMPLATE_VARIABLE_LIST, truncateTo200Chars, type TemplateVariable } from "../contract";
import type { ModuleAction, ModuleDiagnostic, ModuleEvent, ModuleExecutionContext, ModuleResult, ModuleStreamState } from "../contract";
import {
  commandFromMessage,
  chatStatusMeetsTier,
  cooldownRemaining,
} from "./domain";
import type { TextCommandInput } from "./domain";
import type { TextCommand } from "./contracts";
import type { TextCommandRepository } from "./repository";
import { NO_COMMANDS_REPLY, TEXT_COMMAND_DEFAULT_USAGE_TEXT, commandListReply } from "./contracts/chat-defaults";

const CHAT_MESSAGE_MAXIMUM_LENGTH = 500;

const recordValue = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;

const messageText = (event: ModuleEvent): string | null => {
  const message = recordValue(event.payload.message, "text");
  return typeof message === "string" ? message : null;
};

const textValue = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const userFor = (event: ModuleEvent): string => event.actor?.login ?? textValue(event.payload.chatter_user_login) ?? "unknown";
const userIdFor = (event: ModuleEvent): string | null => event.actor?.userId ?? textValue(event.payload.chatter_user_id);
const channelFor = (event: ModuleEvent): string => textValue(event.payload.broadcaster_user_login) ?? event.channelId;

const truncateCommandResponse = (text: string): { text: string; originalLength: number | null } => text.length <= CHAT_MESSAGE_MAXIMUM_LENGTH
  ? { text, originalLength: null }
  : { text: `${text.slice(0, CHAT_MESSAGE_MAXIMUM_LENGTH - 1)}…`, originalLength: text.length };

const diagnosticTriggered = (
  input: Exclude<TextCommandInput, { kind: "unknown" }>,
  command: TextCommand,
  response: string,
  alias: string | null,
  streamState: ModuleStreamState | undefined,
  changedVariable?: { name: string; value: number },
) => ({
  code: "text_commands.triggered" satisfies EventCode,
  detail: {
    name: command.name,
    ...(alias === null ? {} : { alias }),
    ...(input.arguments === undefined ? {} : { arguments: truncateTo200Chars(input.arguments) }),
    response: truncateTo200Chars(response),
    ...(streamState === undefined ? {} : { streamState }),
    ...(changedVariable === undefined ? {} : { variable: changedVariable.name, current: changedVariable.value }),
  },
} as const);

const response = (
  event: ModuleEvent,
  input: Exclude<TextCommandInput, { kind: "unknown" }>,
  command: TextCommand,
  text: string,
  alias: string | null,
  streamState: ModuleStreamState | undefined,
  options: {
    prefixActions?: readonly ModuleAction[];
    forceChat?: boolean;
    diagnostics?: readonly ModuleDiagnostic[];
    changedVariable?: { name: string; value: number; overlayIds: readonly string[] };
    noChat?: boolean;
  } = {},
): ModuleResult => {
  const prepared = truncateCommandResponse(text);
  const replyToMessageId = textValue(event.payload.message_id);
  const action = !options.forceChat && command.responseType === "announcement"
    ? { kind: "announcement" as const, text: prepared.text }
    : {
      kind: "chat" as const,
      text: prepared.text,
      ...(!options.forceChat && command.responseType === "reply" && replyToMessageId !== null
        ? { replyToMessageId }
        : {}),
    };
  return {
    actions: [...(options.prefixActions ?? []), ...(!options.noChat && prepared.text.length > 0 ? [action] : [])],
    diagnostics: [
      ...(prepared.originalLength === null ? [] : [{ code: "template_truncated" satisfies EventCode, detail: { current: prepared.originalLength } }]),
      ...(options.diagnostics ?? []),
      diagnosticTriggered(input, command, prepared.text, alias, streamState, options.changedVariable),
    ],
    ...(options.changedVariable === undefined ? {} : { variableChanges: [options.changedVariable] }),
  };
};

const rejection = (code: EventCode, detail: NonNullable<ModuleDiagnostic["detail"]>): ModuleResult => ({
  actions: [],
  diagnostics: [{ code, detail }],
});

const argumentValue = (value: string | undefined): number | null => {
  const normalized = value?.trim().split(/\s+/u)[0] ?? "";
  if (!/^-?(?:0|[1-9]\d*)$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= CHANNEL_VARIABLE_MINIMUM_VALUE && parsed <= CHANNEL_VARIABLE_MAXIMUM_VALUE
    ? parsed
    : null;
};

const moduleValuesFor = (
  event: ModuleEvent,
  input: Exclude<TextCommandInput, { kind: "unknown" }>,
  command: TextCommand,
  alias: string | null,
): Readonly<Record<string, string | number>> => {
  const args = input.arguments?.trim() ?? "";
  const firstArgument = args.split(/\s+/u)[0] ?? "";
  const target = firstArgument.length === 0
    ? userFor(event)
    : firstArgument.replace(/^@/u, "").toLowerCase();
  return {
    target,
    args: args.length > 100 ? `${args.slice(0, 99)}…` : args,
    command: alias ?? input.name,
    cooldown: command.cooldownSeconds,
    uses: command.useCount,
    ...(command.offlineText === undefined ? {} : { offlineText: command.offlineText }),
    ...(command.notFollowingText === undefined ? {} : { notFollowingText: command.notFollowingText }),
    ...(command.unavailableText === undefined ? {} : { unavailableText: command.unavailableText }),
    ...(command.legacyFallback === true ? { legacyFallback: "true" } : {}),
    ...(command.legacyKind === undefined ? {} : { legacyKind: command.legacyKind }),
  };
};

const moduleTemplateVariables = Object.values({
  text: [
    { name: "target", group: "context", contexts: ["chat_command"], sample: "friend", maxLength: 25 },
    { name: "args", group: "context", contexts: ["chat_command"], sample: "hello everyone", maxLength: 100 },
    { name: "command", group: "command", contexts: ["chat_command"], sample: "hello", maxLength: 33 },
    { name: "cooldown", group: "command", contexts: ["chat_command"], sample: "5", maxLength: 5 },
    { name: "uses", group: "command", contexts: ["chat_command"], sample: "12", maxLength: 10 },
  ],
}).flat() as TemplateVariable[];

const render = async (
  context: Partial<Pick<ModuleExecutionContext, "renderTemplate">>,
  event: ModuleEvent,
  input: Exclude<TextCommandInput, { kind: "unknown" }>,
  command: TextCommand,
  alias: string | null,
  text: string,
  changedVariable?: { name: string; value: number },
): Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[] }> => {
  const values = moduleValuesFor(event, input, command, alias);
  if (context.renderTemplate !== undefined) return context.renderTemplate(text, values, changedVariable);
  const systemValues = {
    user: userFor(event),
    channel: channelFor(event),
    ...values,
  };
  return {
    text: renderTemplate(text, systemValues, {}, effectiveTemplateVariables("chat_command", moduleTemplateVariables, [], SYSTEM_TEMPLATE_VARIABLE_LIST)),
    diagnostics: [],
  };
};

const processTextCommandMessageAttempt = async (
  event: ModuleEvent,
  repository: TextCommandRepository,
  context: Partial<Pick<ModuleExecutionContext, "streamState" | "renderTemplate" | "prepareVariableChange">>,
  staleRetries: number,
): Promise<ModuleResult> => {
  const text = messageText(event);
  if (text === null) return { actions: [], diagnostics: [] };
  const input = commandFromMessage(text);
  if (input === null) return { actions: [], diagnostics: [] };
  if (input.kind === "unknown") return { actions: [], diagnostics: [{ code: "text_commands.unknown" satisfies EventCode }] };

  let command = await repository.find(event.channelId, input.name);
  let alias: string | null = null;
  if (command === null) {
    command = await repository.findByAlias(event.channelId, input.name);
    if (command !== null) alias = input.name;
  }
  if (command === null) return rejection("text_commands.unknown", { name: input.name });
  if (!command.enabled) return rejection("text_commands.disabled", { name: command.name });
  if (!chatStatusMeetsTier(event.chatStatus, command.minimumTier)) {
    return rejection("text_commands.permission_denied", {
      name: command.name,
      requiredTier: command.minimumTier,
      currentTier: event.chatStatus,
    });
  }

  let streamState: ModuleStreamState | undefined;
  if (command.streamCondition !== "any") {
    streamState = await (context.streamState ?? (() => Promise.resolve("unknown")))();
    if (streamState !== "unknown" && streamState !== command.streamCondition) {
      return rejection("text_commands.stream_state", { name: command.name, allowed: command.streamCondition, streamState });
    }
  }

  const action = command.variableAction;
  const parsedAmount = action?.operation === "set_argument" ? argumentValue(input.arguments) : undefined;
  const invalidActionArgument = action?.operation === "set_argument" && parsedAmount === null;
  if (invalidActionArgument) {
    return response(
      event,
      input,
      command,
      command.usageText ?? TEXT_COMMAND_DEFAULT_USAGE_TEXT,
      alias,
      streamState,
      { forceChat: true, diagnostics: [{ code: "text_commands.argument_invalid" satisfies EventCode, detail: { name: command.name } }] },
    );
  }
  const claim = await repository.claim(
    event.channelId,
    command.name,
    event.receivedAt,
    userIdFor(event),
    command.userCooldownSeconds,
    context.prepareVariableChange,
    parsedAmount,
    command,
  );
  if (claim === null) return rejection("text_commands.unknown", { name: input.name });
  if (claim.stale) {
    return staleRetries < 1
      ? processTextCommandMessageAttempt(event, repository, context, staleRetries + 1)
      : rejection("text_commands.changed_concurrently", { name: command.name });
  }
  if (!claim.claimed) {
    if (claim.reason === "variable_update_failed") {
      return rejection("text_commands.variable_update_failed", { name: command.name });
    }
    const remainingSeconds = claim.remainingSeconds ?? cooldownRemaining(claim.command.lastUsedAt, event.receivedAt, claim.command.cooldownSeconds);
    return claim.reason === "user_cooldown"
      ? rejection("text_commands.user_cooldown", { name: command.name, remainingSeconds })
      : rejection("text_commands.cooldown", { name: command.name, remainingSeconds });
  }

  const claimed = claim.command;
  const changedVariableForResult = claim.changedVariable === undefined ? undefined : {
    ...claim.changedVariable,
    overlayIds: claim.changedVariableOverlayIds ?? [],
  };
  if (claimed.kind === "list") {
    const commands = (await repository.list(event.channelId)).filter((entry) => entry.enabled).sort((left, right) => left.name.localeCompare(right.name));
    const list = commands.length === 0 ? NO_COMMANDS_REPLY : commandListReply(commands.map((entry) => entry.name));
    return response(event, input, claimed, list, alias, streamState,
      changedVariableForResult === undefined ? {} : { changedVariable: changedVariableForResult });
  }

  if (claimed.kind === "shoutout") {
    const target = input.arguments?.trim().split(/\s+/u)[0]?.replace(/^@/u, "").toLowerCase() ?? "";
    if (typeof target !== "string" || !/^[a-zA-Z0-9_]{1,25}$/u.test(target)) {
      return response(event, input, claimed, claimed.usageText ?? TEXT_COMMAND_DEFAULT_USAGE_TEXT, alias, streamState, {
        forceChat: true,
        diagnostics: [{ code: "text_commands.argument_missing" satisfies EventCode, detail: { name: claimed.name } }],
      });
    }
    const rendered = await render(context, event, input, claimed, alias, claimed.text, claim.changedVariable);
    return response(event, input, claimed, rendered.text, alias, streamState, {
      forceChat: true,
      prefixActions: [{ kind: "shoutout", targetLogin: target }],
      diagnostics: rendered.diagnostics,
      ...(changedVariableForResult === undefined ? {} : { changedVariable: changedVariableForResult }),
    });
  }

  const rendered = await render(context, event, input, claimed, alias, claimed.text, claim.changedVariable);
  return response(event, input, claimed, rendered.text, alias, streamState, {
    diagnostics: [
      ...rendered.diagnostics,
    ],
    ...(changedVariableForResult === undefined ? {} : { changedVariable: changedVariableForResult }),
    noChat: rendered.text.length === 0,
  });
};

export const processTextCommandMessage = (
  event: ModuleEvent,
  repository: TextCommandRepository,
  context: Partial<Pick<ModuleExecutionContext, "streamState" | "renderTemplate" | "prepareVariableChange">> = {},
): Promise<ModuleResult> => processTextCommandMessageAttempt(event, repository, context, 0);
