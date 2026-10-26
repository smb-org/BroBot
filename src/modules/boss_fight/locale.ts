import type { ModuleLanguage } from "../contract";
import { reserveChatTextBeforeSuffix } from "../../contracts/chat-text";
import type { BossPayout } from "./domain/boss";

export const bossFightCatalog = {
  de: {
    title: "Bosskampf",
    description: "Starte einen Bosskampf live und lass den Chat gemeinsam um Beute kämpfen.",
    startLine: "🐉 Ein Boss erscheint!",
    defeatedText: "🏆 Der Boss ist besiegt!",
    timeoutLine: "Der Boss hat überlebt. Niemand erhält Beute.",
    actionName: "Bosskampf starten",
    actionError: "Der Bosskampf konnte nicht gestartet werden.",
    actionStarted: "Bosskampf gestartet.",
    roundRunning: "Ein Bosskampf läuft bereits.",
    streamOffline: "Der Stream ist nicht live.",
    commandDescription: "Greift den laufenden Bosskampf an.",
    attackHint: "Schreib !attack, um den Boss anzugreifen.",
    attacker: () => "Angreifer",
    payout: (dealer: Pick<BossPayout, "login" | "damage" | "amount">) => `@${dealer.login.slice(0, 25)} ${String(dealer.damage)} Schaden${dealer.amount > 0 ? ` · ${String(dealer.amount)} Punkte` : ""}`,
    topDamage: (names: string, more: number) => ` Top-Schaden: ${names}${more > 0 ? `, +${String(more)} weitere` : ""}.`,
    noDamage: " Noch kein Schaden.",
    timeLeft: (remaining: string) => `Noch ${remaining}`,
    save: "Speichern",
    saved: "Gespeichert",
    saveError: "Einstellungen konnten nicht gespeichert werden.",
    invalid: "Bitte prüfe deine Eingaben.",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern.",
    chatOutput: "Chat-Ausgabe",
    rules: "Rundenregeln",
    reward: "Beute",
    messages: "Chat-Nachrichten",
    durationSeconds: "Angriffszeit",
    attackCooldownSeconds: "Abklingzeit pro Person",
    damageMinimum: "Mindester Schaden",
    damageMaximum: "Höchster Schaden",
    lootPool: "Beutepool",
    startMessageField: "Startmeldung",
    defeatedMessageField: "Siegmeldung",
    timeoutMessageField: "Meldung bei Ablauf",
    messageHint: "Wird um dynamische Rundendaten ergänzt.",
    seconds: "s",
    points: "Punkte",
    messageEnabled: "Nachricht senden",
    minimumExceedsMaximum: "Der Mindestschaden darf den höchsten Schaden nicht überschreiten.",
    bounds: "Wert außerhalb des erlaubten Bereichs.",
  },
  en: {
    title: "Boss fight",
    description: "Start a live boss fight and let chat work together for the loot.",
    startLine: "🐉 A boss appears!",
    defeatedText: "🏆 The boss is defeated!",
    timeoutLine: "The boss survived. Nobody receives loot.",
    actionName: "Start boss fight",
    actionError: "The boss fight could not be started.",
    actionStarted: "Boss fight started.",
    roundRunning: "A boss fight is already running.",
    streamOffline: "The stream is not live.",
    commandDescription: "Attack the active boss fight.",
    attackHint: "Type !attack to hit the boss.",
    attacker: (count: number) => count === 1 ? "attacker" : "attackers",
    payout: (dealer: Pick<BossPayout, "login" | "damage" | "amount">) => `@${dealer.login.slice(0, 25)} ${String(dealer.damage)} dmg${dealer.amount > 0 ? ` · ${String(dealer.amount)} pts` : ""}`,
    topDamage: (names: string, more: number) => ` Top damage: ${names}${more > 0 ? `, +${String(more)} more` : ""}.`,
    noDamage: " No damage yet.",
    timeLeft: (remaining: string) => `${remaining} left`,
    save: "Save",
    saved: "Saved",
    saveError: "Settings could not be saved.",
    invalid: "Check the values and try again.",
    readOnlyReason: "Only broadcasters and managers may change these settings.",
    chatOutput: "Chat output",
    rules: "Round rules",
    reward: "Loot",
    messages: "Chat messages",
    durationSeconds: "Attack window",
    attackCooldownSeconds: "Cooldown per viewer",
    damageMinimum: "Minimum damage",
    damageMaximum: "Maximum damage",
    lootPool: "Loot pool",
    startMessageField: "Start message",
    defeatedMessageField: "Victory message",
    timeoutMessageField: "Timeout message",
    messageHint: "Dynamic round details are appended automatically.",
    seconds: "s",
    points: "points",
    messageEnabled: "Send message",
    minimumExceedsMaximum: "Minimum damage cannot exceed maximum damage.",
    bounds: "Value is outside the allowed range.",
  },
} as const;

export interface BossFightOutcomeLineInput {
  language: ModuleLanguage;
  summary: string;
  topDamageDealers: readonly Pick<BossPayout, "login" | "damage" | "amount">[];
  otherCount: number;
  attributions?: readonly string[];
}

const oneLine = (text: string): string => text.trim().replace(/\s+/gu, " ");

// The mandatory part (command hint, top damage) is reserved first, so neither the custom text nor
// the transport attributions appended by the host can cut it off.
const withMandatorySuffix = (summary: string, suffix: string, attributions: readonly string[] | undefined): string =>
  reserveChatTextBeforeSuffix(oneLine(summary), suffix, attributions)?.trim() ?? oneLine(suffix).slice(0, 500);

export const formatBossOutcomeLine = (input: BossFightOutcomeLineInput): string => {
  const copy = bossFightCatalog[input.language];
  const names = input.topDamageDealers.slice(0, 3).map(copy.payout).join(", ");
  const ending = names.length === 0 ? copy.noDamage : copy.topDamage(names, Math.max(0, input.otherCount));
  return withMandatorySuffix(input.summary, ending, input.attributions);
};

export const formatBossStartLine = (input: {
  language: ModuleLanguage;
  summary: string;
  durationSeconds: number;
  attributions?: readonly string[];
}): string => {
  const copy = bossFightCatalog[input.language];
  return withMandatorySuffix(input.summary, ` ${copy.attackHint} (${String(input.durationSeconds)} ${copy.seconds})`, input.attributions);
};
