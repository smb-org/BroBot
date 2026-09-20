import { kuerzeAuf200Zeichen } from "../contract";
import type { ModuleEvent, ModuleResult } from "../contract";
import {
  befehlAusNachricht,
  befehlTextMitPlatzhaltern,
  cooldownRestzeit,
  gueltigerBefehlsname,
} from "./domain";
import type { TextbefehlRepository } from "./repository";

export const TEXTBEFEHL_DEFAULT_COOLDOWN_SEKUNDEN = 5;

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

const diagnoseAusgeloest = (nachricht: string, antwort: string) => {
  const match = /^!(\S+)(?:\s+([\s\S]*))?$/u.exec(nachricht.trim());
  const argumente = match?.[2]?.trim();
  return {
    code: "textbefehle.ausgeloest",
    detail: {
      name: match?.[1] ?? "",
      ...(argumente === undefined || argumente.length === 0
        ? {}
        : { argumente: kuerzeAuf200Zeichen(argumente) }),
      antwort: kuerzeAuf200Zeichen(antwort),
    },
  } as const;
};

const antwort = (event: ModuleEvent, nachricht: string, text: string): ModuleResult => {
  const replyToMessageId = textWert(event.payload.message_id);
  return {
    actions: [{
      kind: "chat",
      text,
      ...(replyToMessageId === null ? {} : { replyToMessageId }),
    }],
    diagnostics: [diagnoseAusgeloest(nachricht, text)],
  };
};

const nichtBerechtigt = (): ModuleResult => ({
  actions: [],
  diagnostics: [{ code: "textbefehle.nicht_berechtigt" }],
});

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

  if (eingabe.art === "hinzufuegen") {
    if (event.actor?.role === null || event.actor === null) return nichtBerechtigt();
    if (!gueltigerBefehlsname(eingabe.name) || eingabe.text.length === 0) {
      return { actions: [], diagnostics: [{ code: "textbefehle.ungueltig" }] };
    }
    const angelegt = await repository.anlegen({
      channelId: event.channelId,
      name: eingabe.name,
      text: eingabe.text,
      cooldownSekunden: TEXTBEFEHL_DEFAULT_COOLDOWN_SEKUNDEN,
      now: event.receivedAt,
    }, { userId: event.actor.userId });
    return angelegt
      ? antwort(event, text, `Befehl !${eingabe.name} wurde angelegt.`)
      : { actions: [], diagnostics: [{ code: "textbefehle.bereits_vorhanden", detail: { name: eingabe.name } }] };
  }

  if (eingabe.art === "entfernen") {
    if (event.actor?.role === null || event.actor === null) return nichtBerechtigt();
    if (!gueltigerBefehlsname(eingabe.name)) {
      return { actions: [], diagnostics: [{ code: "textbefehle.ungueltig" }] };
    }
    const entfernt = await repository.loeschen(event.channelId, eingabe.name, { userId: event.actor.userId }, event.receivedAt);
    return entfernt
      ? antwort(event, text, `Befehl !${eingabe.name} wurde entfernt.`)
      : { actions: [], diagnostics: [{ code: "textbefehle.unbekannt", detail: { name: eingabe.name } }] };
  }

  if (eingabe.art === "listen") {
    const befehle = await repository.auflisten(event.channelId);
    const liste = befehle.length === 0
      ? "Keine Textbefehle angelegt."
      : `Befehle: ${befehle.map((befehl) => `!${befehl.name}`).join(", ")}`;
    return antwort(event, text, liste);
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

  return antwort(event, text, befehlTextMitPlatzhaltern(
    beanspruchung.befehl.text,
    userFuer(event),
    channelFuer(event),
  ));
};
