import { kuerzeAuf200Zeichen } from "../contract";
import type { ModuleEvent, ModuleResult } from "../contract";
import {
  befehlAusNachricht,
  befehlTextMitPlatzhaltern,
  cooldownRestzeit,
  gueltigerBefehlsname,
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
  eingabe: Exclude<TextbefehlEingabe, { art: "unbekannt" }>,
  antwort: string,
) => {
  const argumente = eingabe.argumente;
  return {
    code: "textbefehle.ausgeloest",
    detail: {
      name: eingabe.name,
      ...(argumente === undefined || argumente.length === 0
        ? {}
        : { argumente: kuerzeAuf200Zeichen(argumente) }),
      antwort: kuerzeAuf200Zeichen(antwort),
    },
  } as const;
};

const antwort = (event: ModuleEvent, eingabe: Exclude<TextbefehlEingabe, { art: "unbekannt" }>, text: string): ModuleResult => {
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

  if (eingabe.art === "unbekannt") {
    return { actions: [], diagnostics: [{ code: "textbefehle.unbekannt" }] };
  }

  if (eingabe.art === "listen") {
    const befehle = await repository.auflisten(event.channelId);
    const liste = befehle.length === 0
      ? "Keine Textbefehle angelegt."
      : `Befehle: ${befehle.map((befehl) => `!${befehl.name}`).join(", ")}`;
    return antwort(event, eingabe, liste);
  }

  if (!gueltigerBefehlsname(eingabe.name)) {
    return { actions: [], diagnostics: [{ code: "textbefehle.ungueltig" }] };
  }
  const beanspruchung = await repository.beanspruchen(event.channelId, eingabe.name, event.receivedAt);
  if (beanspruchung === null) {
    return {
      actions: [],
      diagnostics: [{ code: "textbefehle.unbekannt", detail: { name: eingabe.name } }],
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
      diagnostics: [{ code: "textbefehle.abgekuehlt", detail: { name: eingabe.name, restSekunden } }],
    };
  }

  return antwort(event, eingabe, befehlTextMitPlatzhaltern(
    beanspruchung.befehl.text,
    userFuer(event),
    channelFuer(event),
  ));
};
