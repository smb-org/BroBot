import type { ModuleLanguage } from "../contract";

export const pointsCatalog = {
  de: {
    name: "Punkte",
    description: "Punkte sammeln und Konten verwalten.",
    commands: {
      balance: "Zeigt deinen Kontostand und deine Monatsplatzierung.",
      top: "Zeigt die höchsten Spielgewinne dieses Monats.",
      games: "Zeigt verfügbare Spiele und den Startbonus.",
    },
    chat: {
      balance: (balance: string, currency: string, net: string, rank: number | null) => rank === null
        ? `${balance} ${currency} · diesen Monat noch kein Spiel`
        : `${balance} ${currency} · diesen Monat ${net} · Platz ${String(rank)}`,
      top: (month: string, entries: readonly { login: string; net: number }[], currency: string) => entries.length === 0
        ? `Top im ${month}: Noch keine Spielergebnisse.`
        : `Top im ${month}: ${entries.map((entry, index) => `${String(index + 1)}. ${entry.login} ${entry.net >= 0 ? "+" : ""}${new Intl.NumberFormat("de-DE").format(entry.net)}`).join(" · ")} ${currency}`,
      games: (games: readonly string[]) => games.length === 0 ? "Noch sind keine Spiele aktiv." : `Aktive Spiele: ${games.join(" · ")}`,
      startBonus: (amount: number, currency: string) => `Startguthaben ${new Intl.NumberFormat("de-DE").format(amount)} ${currency}`,
      safetyNet: (amount: number, currency: string) => `Notgroschen: +${new Intl.NumberFormat("de-DE").format(amount)} ${currency}.`,
      blitzGame: "Blitzrunde (einfach mitraten)",
    },
  },
  en: {
    name: "Points",
    description: "Earn points and manage accounts.",
    commands: {
      balance: "Shows your balance and monthly placement.",
      top: "Shows the highest game earnings this month.",
      games: "Shows available games and the start bonus.",
    },
    chat: {
      balance: (balance: string, currency: string, net: string, rank: number | null) => rank === null
        ? `${balance} ${currency} · no game this month yet`
        : `${balance} ${currency} · this month ${net} · place ${String(rank)}`,
      top: (month: string, entries: readonly { login: string; net: number }[], currency: string) => entries.length === 0
        ? `Top in ${month}: No game results yet.`
        : `Top in ${month}: ${entries.map((entry, index) => `${String(index + 1)}. ${entry.login} ${entry.net >= 0 ? "+" : ""}${new Intl.NumberFormat("en-US").format(entry.net)}`).join(" · ")} ${currency}`,
      games: (games: readonly string[]) => games.length === 0 ? "No games are active yet." : `Active games: ${games.join(" · ")}`,
      startBonus: (amount: number, currency: string) => `Start balance ${new Intl.NumberFormat("en-US").format(amount)} ${currency}`,
      safetyNet: (amount: number, currency: string) => `Safety net: +${new Intl.NumberFormat("en-US").format(amount)} ${currency}.`,
      blitzGame: "Blitz Round (just guess along)",
    },
  },
} satisfies Readonly<Record<ModuleLanguage, object>>;

