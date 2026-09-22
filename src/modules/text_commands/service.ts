import { kuerzeAuf200Zeichen } from "../contract";
import type { ModuleEvent, ModuleResult } from "../contract";
import {
  commandFromMessage,
  commandTextWithPlaceholders,
  chatStatusMeetsTier,
  cooldownRestzeit,
} from "./domain";
import type { TextCommandInput } from "./domain";
import type { TextCommandRepository } from "./repository";

const recordValue = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;

const nachrichtText = (event: ModuleEvent): string | null => {
  const message = recordValue(event.payload.message, "text");
  return typeof message === "string" ? message : null;
};

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const userFor = (event: ModuleEvent): string =>
  event.actor?.login ?? textValue(event.payload.chatter_user_login) ?? "unbekannt";

const channelFor = (event: ModuleEvent): string =>
  textValue(event.payload.broadcaster_user_login) ?? event.channelId;

const diagnoseAusgeloest = (
  eingabe: Exclude<TextCommandInput, { kind: "unbekannt" }>,
  response: string,
) => {
  const argumente = eingabe.argumente;
  return {
    code: "text_commands.ausgeloest",
    detail: {
      name: eingabe.name,
      ...(argumente === undefined || argumente.length === 0
        ? {}
        : { argumente: kuerzeAuf200Zeichen(argumente) }),
      response: kuerzeAuf200Zeichen(response),
    },
  } as const;
};

const response = (event: ModuleEvent, eingabe: Exclude<TextCommandInput, { kind: "unbekannt" }>, text: string): ModuleResult => {
  const replyToMessageId = textValue(event.payload.message_id);
  return {
    actions: [{
      kind: "chat",
      text,
      ...(replyToMessageId === null ? {} : { replyToMessageId }),
    }],
    diagnostics: [diagnoseAusgeloest(eingabe, text)],
  };
};

export const processTextCommandMessage = async (
  event: ModuleEvent,
  repository: TextCommandRepository,
): Promise<ModuleResult> => {
  const text = nachrichtText(event);
  if (text === null) return { actions: [], diagnostics: [] };
  const eingabe = commandFromMessage(text);
  if (eingabe === null) return { actions: [], diagnostics: [] };

  if (eingabe.kind === "unbekannt") {
    return { actions: [], diagnostics: [{ code: "text_commands.unbekannt" }] };
  }

  const command = await repository.finden(event.channelId, eingabe.name);
  if (command === null) {
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.unbekannt", detail: { name: eingabe.name } }],
    };
  }
  if (!command.enabled) {
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.deaktiviert", detail: { name: eingabe.name } }],
    };
  }
  if (!chatStatusMeetsTier(event.chatStatus, command.minimumTier)) {
    return {
      actions: [],
      diagnostics: [{
        code: "text_commands.berechtigung",
        detail: {
          name: eingabe.name,
          requiredTier: command.minimumTier,
          currentTier: event.chatStatus,
        },
      }],
    };
  }

  const beanspruchung = await repository.beanspruchen(event.channelId, eingabe.name, event.receivedAt);
  if (beanspruchung === null) {
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.unbekannt", detail: { name: eingabe.name } }],
    };
  }
  if (!beanspruchung.beansprucht) {
    const restSekunden = cooldownRestzeit(
      beanspruchung.befehl.lastUsedAt,
      event.receivedAt,
      beanspruchung.befehl.cooldownSeconds,
    );
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.abgekuehlt", detail: { name: eingabe.name, remainingSeconds: restSekunden } }],
    };
  }

  if (beanspruchung.befehl.kind === "list") {
    const commands = (await repository.list(event.channelId))
      .filter((command) => command.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
    const list = commands.length === 0
      ? "Keine Textbefehle angelegt."
      : `Befehle: ${commands.map((command) => `!${command.name}`).join(", ")}`;
    return response(event, eingabe, list);
  }

  return response(event, eingabe, commandTextWithPlaceholders(
    beanspruchung.befehl.text,
    userFor(event),
    channelFor(event),
  ));
};
