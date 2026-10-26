import type { ModuleLanguage } from "../contract";

export interface HeistCatalog {
  title: string;
  description: string;
  startText: string;
  resultText: string;
  noParticipants: string;
  moreNames: (count: number) => string;
  joinWindowVariableLabel: string;
  joinWindowVariableDescription: string;
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
    startText: "💰 Überfall offen für {heist.seconds} s: Mit !heist <Einsatz> mitmachen.",
    resultText: "Überfall: Gewinner ×2: {heist.winners} · verloren: {heist.losers} · Chance {heist.chance}%.",
    noParticipants: "niemand",
    moreNames: (count) => `+${String(count)} weitere`,
    joinWindowVariableLabel: "Beitrittszeit",
    joinWindowVariableDescription: "Sekunden bis zum Ende des Beitrittsfensters.",
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
    startText: "💰 Heist open for {heist.seconds} s: join with !heist <stake>.",
    resultText: "Heist: winners ×2: {heist.winners} · lost: {heist.losers} · {heist.chance}% chance.",
    noParticipants: "nobody",
    moreNames: (count) => `+${String(count)} more`,
    joinWindowVariableLabel: "Join window",
    joinWindowVariableDescription: "Seconds until the join window closes.",
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

export const formatHeistNames = (logins: readonly string[], language: ModuleLanguage): string => {
  const copy = heistCatalog[language];
  if (logins.length === 0) return copy.noParticipants;
  const names = logins.slice(0, 5).map((login) => login.slice(0, 25));
  const remaining = logins.length - names.length;
  if (remaining > 0) names.push(copy.moreNames(remaining));
  return names.join(", ");
};
