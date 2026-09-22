import { truncateTo200Chars } from "../contract";
import type { ModuleEvent, ModuleResult } from "../contract";
import {
  commandFromMessage,
  commandTextWithPlaceholders,
  chatStatusMeetsTier,
  cooldownRemaining,
} from "./domain";
import type { TextCommandInput } from "./domain";
import type { TextCommandRepository } from "./repository";

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
  event.actor?.login ?? textValue(event.payload.chatter_user_login) ?? "unbekannt";

const channelFor = (event: ModuleEvent): string =>
  textValue(event.payload.broadcaster_user_login) ?? event.channelId;

const diagnosticTriggered = (
  input: Exclude<TextCommandInput, { kind: "unknown" }>,
  response: string,
) => {
  const argumente = input.argumente;
  return {
    code: "text_commands.ausgeloest",
    detail: {
      name: input.name,
      ...(argumente === undefined || argumente.length === 0
        ? {}
        : { argumente: truncateTo200Chars(argumente) }),
      response: truncateTo200Chars(response),
    },
  } as const;
};

const response = (event: ModuleEvent, input: Exclude<TextCommandInput, { kind: "unknown" }>, text: string): ModuleResult => {
  const replyToMessageId = textValue(event.payload.message_id);
  return {
    actions: [{
      kind: "chat",
      text,
      ...(replyToMessageId === null ? {} : { replyToMessageId }),
    }],
    diagnostics: [diagnosticTriggered(input, text)],
  };
};

export const processTextCommandMessage = async (
  event: ModuleEvent,
  repository: TextCommandRepository,
): Promise<ModuleResult> => {
  const text = messageText(event);
  if (text === null) return { actions: [], diagnostics: [] };
  const input = commandFromMessage(text);
  if (input === null) return { actions: [], diagnostics: [] };

  if (input.kind === "unknown") {
    return { actions: [], diagnostics: [{ code: "text_commands.unbekannt" }] };
  }

  const command = await repository.find(event.channelId, input.name);
  if (command === null) {
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.unbekannt", detail: { name: input.name } }],
    };
  }
  if (!command.enabled) {
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.deaktiviert", detail: { name: input.name } }],
    };
  }
  if (!chatStatusMeetsTier(event.chatStatus, command.minimumTier)) {
    return {
      actions: [],
      diagnostics: [{
        code: "text_commands.berechtigung",
        detail: {
          name: input.name,
          requiredTier: command.minimumTier,
          currentTier: event.chatStatus,
        },
      }],
    };
  }

  const claim = await repository.claim(event.channelId, input.name, event.receivedAt);
  if (claim === null) {
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.unbekannt", detail: { name: input.name } }],
    };
  }
  if (!claim.claimed) {
    const remainingSeconds = cooldownRemaining(
      claim.command.lastUsedAt,
      event.receivedAt,
      claim.command.cooldownSeconds,
    );
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.abgekuehlt", detail: { name: input.name, remainingSeconds } }],
    };
  }

  if (claim.command.kind === "list") {
    const commands = (await repository.list(event.channelId))
      .filter((command) => command.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
    const list = commands.length === 0
      ? "Keine Textbefehle angelegt."
      : `Befehle: ${commands.map((command) => `!${command.name}`).join(", ")}`;
    return response(event, input, list);
  }

  return response(event, input, commandTextWithPlaceholders(
    claim.command.text,
    userFor(event),
    channelFor(event),
  ));
};
