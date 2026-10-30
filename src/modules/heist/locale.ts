import type { ModuleLanguage } from "../contract";

export interface HeistCatalog {
  title: string;
  description: string;
  commandDescription: string;
  commandSyntax: string;
  stakeArgument: string;
  stakeHint: string;
  startText: string;
  confirmText: string;
  resultText: string;
  noParticipants: string;
  moreNames: (count: number) => string;
  joinWindowVariableLabel: string;
  joinWindowVariableDescription: string;
  countVariableLabel: string;
  countVariableDescription: string;
  namesVariableLabel: string;
  namesVariableDescription: string;
  potVariableLabel: string;
  potVariableDescription: string;
  chanceVariableLabel: string;
  chanceVariableDescription: string;
  winnersVariableLabel: string;
  winnersVariableDescription: string;
  losersVariableLabel: string;
  losersVariableDescription: string;
  errors: {
    invalidStake: string;
    stakeBounds: (minimum: number, maximum: number) => string;
    insufficientPoints: string;
    cooldown: string;
    roundRunning: string;
  };
}

export const heistCatalog: Readonly<Record<ModuleLanguage, HeistCatalog>> = {
  de: {
    title: "Überfall",
    description: "Gemeinsamer Punkteüberfall mit individueller Erfolgschance.",
    commandDescription: "Startet einen Überfall oder tritt mit demselben Befehl einer laufenden Runde bei.",
    commandSyntax: "!heist <Einsatz>",
    stakeArgument: "Einsatz",
    stakeHint: "Punkteinsatz für den Überfall.",
    startText: "💰 Überfall offen für {heist.seconds} s: Mit !heist <Einsatz> mitmachen.",
    confirmText: "{heist.count} dabei: {heist.names} · Pott {heist.pot}",
    resultText: "Überfall: Gewinner ×2: {heist.winners} · verloren: {heist.losers} · Chance {heist.chance}%.",
    noParticipants: "niemand",
    moreNames: (count) => `+${String(count)} weitere`,
    joinWindowVariableLabel: "Beitrittszeit",
    joinWindowVariableDescription: "Sekunden bis zum Ende des Beitrittsfensters.",
    countVariableLabel: "Teilnehmerzahl",
    countVariableDescription: "Anzahl der Personen, die bis zur Mitte des Beitrittsfensters dabei sind.",
    namesVariableLabel: "Teilnehmende",
    namesVariableDescription: "Bis zu fünf Namen in Beitrittsreihenfolge mit einem Hinweis auf weitere.",
    potVariableLabel: "Pott",
    potVariableDescription: "Summe aller bisherigen Einsätze.",
    chanceVariableLabel: "Erfolgschance",
    chanceVariableDescription: "Erfolgschance jeder Person in dieser Runde.",
    winnersVariableLabel: "Gewinner",
    winnersVariableDescription: "Bis zu fünf Gewinnernamen mit einem Hinweis auf weitere.",
    losersVariableLabel: "Verlierer",
    losersVariableDescription: "Bis zu fünf Verlierernamen mit einem Hinweis auf weitere.",
    errors: {
      invalidStake: "Verwende !heist <Einsatz> mit einer ganzen Punktzahl.",
      stakeBounds: (minimum, maximum) => `Der Einsatz muss zwischen ${String(minimum)} und ${String(maximum)} Punkten liegen.`,
      insufficientPoints: "Du hast nicht genug Punkte für diesen Einsatz.",
      cooldown: "Ein neuer Überfall ist noch nicht bereit.",
      roundRunning: "Ein Überfall läuft bereits.",
    },
  },
  en: {
    title: "Heist",
    description: "A shared points heist with an individual chance to succeed.",
    commandDescription: "Starts a heist or joins an open round with the same command.",
    commandSyntax: "!heist <stake>",
    stakeArgument: "stake",
    stakeHint: "Point stake for the heist.",
    startText: "💰 Heist open for {heist.seconds} s: join with !heist <stake>.",
    confirmText: "{heist.count} in: {heist.names} · pot {heist.pot}",
    resultText: "Heist: winners ×2: {heist.winners} · lost: {heist.losers} · {heist.chance}% chance.",
    noParticipants: "nobody",
    moreNames: (count) => `+${String(count)} more`,
    joinWindowVariableLabel: "Join window",
    joinWindowVariableDescription: "Seconds until the join window closes.",
    countVariableLabel: "Participants",
    countVariableDescription: "Number of people in by the middle of the join window.",
    namesVariableLabel: "Names",
    namesVariableDescription: "Up to five names in join order followed by a count of the rest.",
    potVariableLabel: "Pot",
    potVariableDescription: "Sum of all stakes so far.",
    chanceVariableLabel: "Success chance",
    chanceVariableDescription: "Each participant's success chance for this round.",
    winnersVariableLabel: "Winners",
    winnersVariableDescription: "Up to five winner names followed by a count of the rest.",
    losersVariableLabel: "Losers",
    losersVariableDescription: "Up to five loser names followed by a count of the rest.",
    errors: {
      invalidStake: "Use !heist <stake> with a whole number of points.",
      stakeBounds: (minimum, maximum) => `Stake must be between ${String(minimum)} and ${String(maximum)} points.`,
      insufficientPoints: "You do not have enough points for that stake.",
      cooldown: "A new heist is not ready yet.",
      roundRunning: "A heist is already running.",
    },
  },
};

/** `total` may exceed the list when only the first names were loaded. */
export const formatHeistNames = (logins: readonly string[], language: ModuleLanguage, total = logins.length): string => {
  const copy = heistCatalog[language];
  if (logins.length === 0) return copy.noParticipants;
  const names = logins.slice(0, 5).map((login) => login.slice(0, 25));
  const remaining = total - names.length;
  if (remaining > 0) names.push(copy.moreNames(remaining));
  return names.join(", ");
};
