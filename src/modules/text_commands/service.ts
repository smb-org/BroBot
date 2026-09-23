import type { EventCode } from "../../contracts/values";
import { truncateTo200Chars } from "../contract";
import type { ModuleAction, ModuleDiagnostic, ModuleEvent, ModuleExecutionContext, ModuleResult, ModuleStreamState } from "../contract";
import {
  commandFromMessage,
  formatFollowage,
  formatUptime,
  renderFollowageText,
  renderGameText,
  renderNotFollowingText,
  renderOfflineText,
  renderShoutoutText,
  renderUnavailableText,
  renderUptimeText,
  renderCommandText,
  chatStatusMeetsTier,
  cooldownRemaining,
} from "./domain";
import type { TextCommandInput } from "./domain";
import type { TextCommand } from "./contracts";
import type { TextCommandRepository } from "./repository";
import { NO_COMMANDS_REPLY, TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES, commandListReply } from "./contracts/chat-defaults";

const CHAT_MESSAGE_MAXIMUM_LENGTH = 500;

const recordValue = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;

const messageText = (event: ModuleEvent): string | null => {
  const message = recordValue(event.payload.message, "text");
  return typeof message === "string" ? message : null;
};

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const userFor = (event: ModuleEvent): string =>
  event.actor?.login ?? textValue(event.payload.chatter_user_login) ?? "unknown";

const userIdFor = (event: ModuleEvent): string | null =>
  event.actor?.userId ?? textValue(event.payload.chatter_user_id);

const channelFor = (event: ModuleEvent): string =>
  textValue(event.payload.broadcaster_user_login) ?? event.channelId;

const truncateCommandResponse = (text: string): { text: string; originalLength: number | null } => text.length <= CHAT_MESSAGE_MAXIMUM_LENGTH
  ? { text, originalLength: null }
  : { text: `${text.slice(0, CHAT_MESSAGE_MAXIMUM_LENGTH - 1)}…`, originalLength: text.length };

const diagnosticTriggered = (
  input: Exclude<TextCommandInput, { kind: "unknown" }>,
  command: TextCommand,
  response: string,
  alias: string | null,
  streamState: ModuleStreamState | undefined,
) => {
  const commandArguments = input.arguments;
  return {
    code: "text_commands.triggered" satisfies EventCode,
    detail: {
      name: command.name,
      ...(alias === null ? {} : { alias }),
      ...(commandArguments === undefined || commandArguments.length === 0
        ? {}
        : { arguments: truncateTo200Chars(commandArguments) }),
      response: truncateTo200Chars(response),
      ...(streamState === undefined ? {} : { streamState }),
    },
  } as const;
};

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
  } = {},
): ModuleResult => {
  const replyToMessageId = textValue(event.payload.message_id);
  const action = !options.forceChat && command.responseType === "announcement"
    ? { kind: "announcement" as const, text }
    : {
      kind: "chat" as const,
      text,
      ...(!options.forceChat && command.responseType === "reply" && replyToMessageId !== null
        ? { replyToMessageId }
        : {}),
    };
  const prepared = truncateCommandResponse(text);
  const diagnostics = [
    ...(prepared.originalLength === null
      ? []
      : [{ code: "template_truncated" satisfies EventCode, detail: { current: prepared.originalLength } }]),
    ...(options.diagnostics ?? []),
    diagnosticTriggered(input, command, prepared.text, alias, streamState),
  ];
  return {
    actions: [...(options.prefixActions ?? []), { ...action, text: prepared.text }],
    diagnostics,
  };
};

const rejection = (code: EventCode, detail: NonNullable<ModuleDiagnostic["detail"]>): ModuleResult => ({
  actions: [],
  diagnostics: [{ code, detail }],
});

export const processTextCommandMessage = async (
  event: ModuleEvent,
  repository: TextCommandRepository,
  context: Partial<Pick<ModuleExecutionContext, "streamState" | "channelInfo" | "followedAt" | "channelLanguage">> = {},
): Promise<ModuleResult> => {
  const text = messageText(event);
  if (text === null) return { actions: [], diagnostics: [] };
  const input = commandFromMessage(text);
  if (input === null) return { actions: [], diagnostics: [] };

  if (input.kind === "unknown") {
    return { actions: [], diagnostics: [{ code: "text_commands.unknown" satisfies EventCode }] };
  }

  let command = await repository.find(event.channelId, input.name);
  let alias: string | null = null;
  if (command === null) {
    command = await repository.findByAlias(event.channelId, input.name);
    if (command !== null) alias = input.name;
  }
  if (command === null) {
    return rejection("text_commands.unknown", { name: input.name });
  }
  if (!command.enabled) {
    return rejection("text_commands.disabled", { name: command.name });
  }
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
      return rejection("text_commands.stream_state", {
        name: command.name,
        allowed: command.streamCondition,
        streamState,
      });
    }
  }

  const claim = await repository.claim(
    event.channelId,
    command.name,
    event.receivedAt,
    userIdFor(event),
    command.userCooldownSeconds,
  );
  if (claim === null) {
    return rejection("text_commands.unknown", { name: command.name });
  }
  if (!claim.claimed) {
    const remainingSeconds = claim.remainingSeconds ?? cooldownRemaining(
      claim.command.lastUsedAt,
      event.receivedAt,
      claim.command.cooldownSeconds,
    );
    return claim.reason === "user_cooldown"
      ? rejection("text_commands.user_cooldown", { name: command.name, remainingSeconds })
      : rejection("text_commands.cooldown", { name: command.name, remainingSeconds });
  }

  if (claim.command.kind === "list") {
    const commands = (await repository.list(event.channelId))
      .filter((entry) => entry.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
    const list = commands.length === 0
      ? NO_COMMANDS_REPLY
      : commandListReply(commands.map((entry) => entry.name));
    return response(event, input, claim.command, list, alias, streamState);
  }

  const claimed = claim.command;
  const user = userFor(event);
  const channel = channelFor(event);
  if (claimed.kind === "text") {
    return response(event, input, claimed, renderCommandText(claimed.text, { user, channel }), alias, streamState);
  }

  const lookupUnavailable = (kind: "uptime" | "followage" | "game"): ModuleDiagnostic => ({
    code: "text_commands.lookup_unavailable" satisfies EventCode,
    detail: { name: claimed.name, kind },
  });

  if (claimed.kind === "uptime") {
    const info = await (context.channelInfo ?? (() => Promise.resolve(null)))();
    if (info === null) return { actions: [], diagnostics: [lookupUnavailable("uptime")] };
    if (info.startedAt === null) {
      return response(
        event,
        input,
        claimed,
        renderOfflineText(claimed.offlineText ?? TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.offlineText, { channel }),
        alias,
        streamState,
      );
    }
    const language = await (context.channelLanguage ?? (() => Promise.resolve("de" as const)))();
    return response(event, input, claimed, renderUptimeText(claimed.text, {
      user,
      channel,
      uptime: formatUptime(info.startedAt, event.receivedAt, language),
    }), alias, streamState);
  }

  if (claimed.kind === "followage") {
    const userId = userIdFor(event);
    const followedAt = userId === null
      ? "unavailable"
      : await (context.followedAt ?? (() => Promise.resolve("unavailable" as const)))(userId);
    if (followedAt === "unavailable") {
      return response(
        event,
        input,
        claimed,
        renderUnavailableText(claimed.unavailableText ?? TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.unavailableText),
        alias,
        streamState,
        { diagnostics: [lookupUnavailable("followage")] },
      );
    }
    if (followedAt === null) {
      return response(
        event,
        input,
        claimed,
        renderNotFollowingText(claimed.notFollowingText ?? TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.notFollowingText, { user, channel }),
        alias,
        streamState,
      );
    }
    const language = await (context.channelLanguage ?? (() => Promise.resolve("de" as const)))();
    return response(event, input, claimed, renderFollowageText(claimed.text, {
      user,
      channel,
      followage: formatFollowage(followedAt, event.receivedAt, language),
    }), alias, streamState);
  }

  if (claimed.kind === "game") {
    const info = await (context.channelInfo ?? (() => Promise.resolve(null)))();
    if (info === null) return { actions: [], diagnostics: [lookupUnavailable("game")] };
    return response(event, input, claimed, renderGameText(claimed.text, {
      channel,
      game: info.gameName,
      title: info.title,
    }), alias, streamState);
  }

  const args = input.arguments?.trim() ?? "";
  if (!/^[a-zA-Z0-9_]{1,25}$/u.test(args)) {
    return response(
      event,
      input,
      claimed,
      renderUnavailableText(claimed.usageText ?? TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.usageText),
      alias,
      streamState,
      {
        forceChat: true,
        diagnostics: [{ code: "text_commands.argument_missing" satisfies EventCode, detail: { name: claimed.name } }],
      },
    );
  }
  return response(event, input, claimed, renderShoutoutText(claimed.text, { user, target: args.toLowerCase() }), alias, streamState, {
    forceChat: true,
    prefixActions: [{ kind: "shoutout", targetLogin: args.toLowerCase() }],
  });
};
