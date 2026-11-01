import type { ModuleLanguage } from "../contract";

const formatExpiry = (expiresAt: string, language: ModuleLanguage, timeZone: string): string => {
  const instant = Date.parse(expiresAt);
  if (!Number.isFinite(instant)) return `${expiresAt} (${timeZone})`;
  const formatted = new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(instant);
  return `${formatted} (${timeZone})`;
};

const formatAllowedDuration = (durationMs: number, language: ModuleLanguage): string => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return language === "de" ? "keine weitere Zeit" : "no additional time";
  const totalMinutes = Math.floor(durationMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    ...(days === 0 ? [] : [language === "de" ? `${String(days)} Tg.` : `${String(days)}d`]),
    ...(hours === 0 ? [] : [language === "de" ? `${String(hours)} Std.` : `${String(hours)}h`]),
    ...(minutes === 0 && days + hours > 0 ? [] : [language === "de" ? `${String(minutes)} Min.` : `${String(minutes)}m`]),
  ];
  return parts.join(" ");
};

const formatRemaining = (durationMs: number, language: ModuleLanguage): string => {
  const totalMinutes = Math.max(1, Math.ceil(Math.max(0, durationMs) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    ...(days === 0 ? [] : [language === "de"
      ? `${String(days)} ${days === 1 ? "Tag" : "Tage"}`
      : `${String(days)} ${days === 1 ? "day" : "days"}`]),
    ...(hours === 0 ? [] : [language === "de"
      ? `${String(hours)} Std.`
      : `${String(hours)} ${hours === 1 ? "hour" : "hours"}`]),
    ...(minutes === 0 && days + hours > 0 ? [] : [language === "de"
      ? `${String(minutes)} Min.`
      : `${String(minutes)} ${minutes === 1 ? "min" : "mins"}`]),
  ];
  return parts.join(" ");
};

const templates = {
  de: {
    usage: "Verwendung: !vip @name [dauer], !unvip @name oder !viptime [@name].",
    invalidDuration: "Ungültige Dauer. Beispiel: !vip @name 30m (mindestens 10 Minuten).",
    unknownLogin: (login: string) => `@${login} wurde auf Twitch nicht gefunden.`,
    lookupUnavailable: "Twitch ist gerade nicht erreichbar. Bitte versuche es gleich erneut.",
    protectedTarget: "Der Broadcaster und der Bot können keine zeitlich begrenzten VIPs sein.",
    granted: (login: string, expiresAt: string) => `@${login} ist jetzt VIP bis ${expiresAt}.`,
    extended: (login: string, expiresAt: string) => `Das VIP von @${login} wurde bis ${expiresAt} verlängert.`,
    maximumExceeded: (duration: string) => `Die Höchstdauer würde überschritten. Du kannst höchstens ${duration} hinzufügen.`,
    alreadyVip: (login: string) => `@${login} ist bereits VIP und wird nicht zeitlich vom Bot verwaltet.`,
    queued: (login: string) => `Die VIP-Änderung für @${login} wartet in der Warteschlange. Bitte gleich erneut prüfen.`,
    rejected: (reason: string) => `Twitch hat die VIP-Änderung abgelehnt (${reason}).`,
    genericFailure: "Die VIP-Änderung konnte nicht abgeschlossen werden. Bitte versuche es gleich erneut.",
    uncertainOutcome: (login: string) => `Ob das geklappt hat, ist unklar. Prüfe mit !viptime @${login}, bevor du es nochmal versuchst.`,
    ended: (login: string) => `Das zeitlich begrenzte VIP von @${login} wurde beendet.`,
    notManaged: (login: string) => `Für @${login} wird kein zeitlich begrenztes VIP vom Bot verwaltet.`,
    noActiveVip: (login: string) => `Für @${login} wird aktuell kein zeitlich begrenztes VIP verwaltet.`,
    permanentVip: (login: string) => `@${login} ist dauerhaft VIP.`,
    unclassifiedVip: (login: string) => `@${login} ist VIP, aber noch nicht eingestuft.`,
    awaitingVip: (login: string) => `Für @${login} wartet der Eintrag auf /vip.`,
    observeVipRequired: (login: string) => `Eine Moderatorin oder ein Moderator muss /vip @${login} auf Twitch ausführen.`,
    observeUnvipRequired: (login: string) => `Eine Moderatorin oder ein Moderator muss /unvip @${login} auf Twitch ausführen.`,
    moduleInactive: "Das VIP-Modul ist deaktiviert. Aktiviere es im Dashboard, um VIPs zu verwalten.",
    activeVip: (login: string, remaining: string, expiresAt: string) => `@${login} ist noch ${remaining} VIP (bis ${expiresAt}).`,
    dueVip: (login: string, expiresAt: string) => `Das VIP von @${login} wartet auf Entfernung; geplant war ${expiresAt}.`,
    retryingVip: (login: string, expiresAt: string) => `Das VIP von @${login} wird erneut entfernt; das geplante Ende war ${expiresAt}.`,
    listUnavailable: "Der VIP-Status ist gerade nicht verfügbar. Bitte versuche es gleich erneut.",
  },
  en: {
    usage: "Usage: !vip @name [duration], !unvip @name, or !viptime [@name].",
    invalidDuration: "Invalid duration. Example: !vip @name 30m (minimum 10 minutes).",
    unknownLogin: (login: string) => `I couldn't find @${login} on Twitch.`,
    lookupUnavailable: "Twitch lookup is unavailable right now. Please try again shortly.",
    protectedTarget: "The broadcaster and bot cannot be temporary VIPs.",
    granted: (login: string, expiresAt: string) => `@${login} is now a VIP until ${expiresAt}.`,
    extended: (login: string, expiresAt: string) => `@${login}'s VIP was extended until ${expiresAt}.`,
    maximumExceeded: (duration: string) => `That exceeds the maximum duration. You can add at most ${duration}.`,
    alreadyVip: (login: string) => `@${login} is already a VIP and is not managed as a temporary VIP.`,
    queued: (login: string) => `The VIP change for @${login} is queued. Check again shortly.`,
    rejected: (reason: string) => `Twitch rejected the VIP change (${reason}).`,
    genericFailure: "The VIP change could not be completed. Please try again shortly.",
    uncertainOutcome: (login: string) => `It is unclear whether that worked. Check with !viptime @${login} before trying again.`,
    ended: (login: string) => `@${login}'s temporary VIP has ended.`,
    notManaged: (login: string) => `@${login} has no temporary VIP managed by this bot.`,
    noActiveVip: (login: string) => `There is no temporary VIP currently managed for @${login}.`,
    permanentVip: (login: string) => `@${login} is a permanent VIP.`,
    unclassifiedVip: (login: string) => `@${login} is a VIP but has not been classified yet.`,
    awaitingVip: (login: string) => `The entry for @${login} is waiting for /vip.`,
    observeVipRequired: (login: string) => `A moderator needs to run /vip @${login} on Twitch.`,
    observeUnvipRequired: (login: string) => `A moderator needs to run /unvip @${login} on Twitch.`,
    moduleInactive: "The VIP module is disabled. Enable it in the dashboard to manage VIPs.",
    activeVip: (login: string, remaining: string, expiresAt: string) => `@${login} is a VIP for another ${remaining} (until ${expiresAt}).`,
    dueVip: (login: string, expiresAt: string) => `@${login}'s VIP is due for removal; its scheduled end was ${expiresAt}.`,
    retryingVip: (login: string, expiresAt: string) => `@${login}'s VIP is being removed again; its scheduled end was ${expiresAt}.`,
    listUnavailable: "VIP status is unavailable right now. Please try again shortly.",
  },
} as const;

type TempVipChatReply = keyof typeof templates.en;

export const tempVipChatText = (
  language: ModuleLanguage,
  key: TempVipChatReply,
  ...args: readonly unknown[]
): string => {
  const template = templates[language][key] as (...values: never[]) => string;
  return typeof template === "function" ? template(...args as never[]) : template;
};

const reasons = {
  de: {
    no_slots: "keine VIP-Plätze frei",
    moderator: "Mods können keine VIPs sein",
    community_gate: "der Kanal erfüllt die VIP-Voraussetzungen noch nicht",
    rate_limited: "Twitch hat zu viele Anfragen erhalten",
    network: "Twitch ist nicht erreichbar",
    not_connected: "der Broadcaster ist nicht mit Twitch verbunden",
    token_unavailable: "das Broadcaster-Token ist nicht verfügbar",
    scope_missing: "die VIP-Berechtigung fehlt",
    revoked: "das Broadcaster-Token wurde widerrufen",
    refresh_failed: "das Broadcaster-Token konnte nicht erneuert werden",
    unknown_status: "Twitch hat einen unbekannten Fehler gemeldet",
    invalid_response: "Twitch hat eine ungültige Antwort gesendet",
    precondition_failed: "der VIP-Status hat sich zwischenzeitlich geändert",
  },
  en: {
    no_slots: "no VIP slots are available",
    moderator: "moderators cannot be VIPs",
    community_gate: "the channel does not meet Twitch's VIP requirements yet",
    rate_limited: "Twitch received too many requests",
    network: "Twitch could not be reached",
    not_connected: "the broadcaster is not connected to Twitch",
    token_unavailable: "the broadcaster token is unavailable",
    scope_missing: "the VIP permission is missing",
    revoked: "the broadcaster token was revoked",
    refresh_failed: "the broadcaster token could not be refreshed",
    unknown_status: "Twitch returned an unknown error",
    invalid_response: "Twitch returned an invalid response",
    precondition_failed: "the VIP status changed during the request",
  },
} as const satisfies Record<ModuleLanguage, Record<string, string>>;

export const resultReasonText = (reason: string | undefined, language: ModuleLanguage): string => {
  const table: Readonly<Record<string, string>> = reasons[language];
  return table[reason ?? ""] ?? (language === "de" ? "ein unerwarteter Twitch-Fehler" : "an unexpected Twitch error");
};

export const formatTempVipExpiry =(expiresAt: string, language: ModuleLanguage, timeZone: string): string =>
  formatExpiry(expiresAt, language, timeZone);

export const formatTempVipAllowedDuration = (durationMs: number, language: ModuleLanguage): string =>
  formatAllowedDuration(durationMs, language);

export const formatTempVipRemaining = (durationMs: number, language: ModuleLanguage): string =>
  formatRemaining(durationMs, language);

