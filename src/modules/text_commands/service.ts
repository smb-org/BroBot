import { kuerzeAuf200Zeichen } from "../contract";
import type { ModuleEvent, ModuleResult } from "../contract";
import {
  befehlAusNachricht,
  befehlTextMitPlatzhaltern,
  chatStatusErfuelltStufe,
  cooldownRestzeit,
} from "./domain";
import type { TextbefehlEingabe } from "./domain";
import type { TextbefehlRepository } from "./repository";

const recordWert = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;

const nachrichtText = (event: ModuleEvent): string | null => {
  const message = recordWert(event.payload.message, "text");
  return typeof message === "string" ? message : null;
};

const textWert = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const userFuer = (event: ModuleEvent): string =>
  event.actor?.login ?? textWert(event.payload.chatter_user_login) ?? "unbekannt";

const channelFuer = (event: ModuleEvent): string =>
  textWert(event.payload.broadcaster_user_login) ?? event.channelId;

const diagnoseAusgeloest = (
  eingabe: Exclude<TextbefehlEingabe, { kind: "unbekannt" }>,
  antwort: string,
) => {
  const argumente = eingabe.argumente;
  return {
    code: "text_commands.ausgeloest",
    detail: {
      name: eingabe.name,
      ...(argumente === undefined || argumente.length === 0
        ? {}
        : { argumente: kuerzeAuf200Zeichen(argumente) }),
      antwort: kuerzeAuf200Zeichen(antwort),
    },
  } as const;
};

const antwort = (event: ModuleEvent, eingabe: Exclude<TextbefehlEingabe, { kind: "unbekannt" }>, text: string): ModuleResult => {
  const replyToMessageId = textWert(event.payload.message_id);
  return {
    actions: [{
      kind: "chat",
      text,
      ...(replyToMessageId === null ? {} : { replyToMessageId }),
    }],
    diagnostics: [diagnoseAusgeloest(eingabe, text)],
  };
};

export const verarbeiteTextbefehlNachricht = async (
  event: ModuleEvent,
  repository: TextbefehlRepository,
): Promise<ModuleResult> => {
  const text = nachrichtText(event);
  if (text === null) return { actions: [], diagnostics: [] };
  const eingabe = befehlAusNachricht(text);
  if (eingabe === null) return { actions: [], diagnostics: [] };

  if (eingabe.kind === "unbekannt") {
    return { actions: [], diagnostics: [{ code: "text_commands.unbekannt" }] };
  }

  const befehl = await repository.finden(event.channelId, eingabe.name);
  if (befehl === null) {
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.unbekannt", detail: { name: eingabe.name } }],
    };
  }
  if (!befehl.enabled) {
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.deaktiviert", detail: { name: eingabe.name } }],
    };
  }
  if (!chatStatusErfuelltStufe(event.chatStatus, befehl.mindeststufe)) {
    return {
      actions: [],
      diagnostics: [{
        code: "text_commands.berechtigung",
        detail: {
          name: eingabe.name,
          geforderteStufe: befehl.mindeststufe,
          vorhandeneStufe: event.chatStatus,
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
      beanspruchung.befehl.zuletztVerwendetAt,
      event.receivedAt,
      beanspruchung.befehl.cooldownSekunden,
    );
    return {
      actions: [],
      diagnostics: [{ code: "text_commands.abgekuehlt", detail: { name: eingabe.name, restSekunden } }],
    };
  }

  if (beanspruchung.befehl.kind === "list") {
    const befehle = (await repository.auflisten(event.channelId))
      .filter((befehl) => befehl.enabled)
      .sort((left, right) => left.name.localeCompare(right.name));
    const liste = befehle.length === 0
      ? "Keine Textbefehle angelegt."
      : `Befehle: ${befehle.map((befehl) => `!${befehl.name}`).join(", ")}`;
    return antwort(event, eingabe, liste);
  }

  return antwort(event, eingabe, befehlTextMitPlatzhaltern(
    beanspruchung.befehl.text,
    userFuer(event),
    channelFuer(event),
  ));
};
