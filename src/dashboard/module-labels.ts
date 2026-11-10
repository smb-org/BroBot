import { catalogString, dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "./locale";
import { MODULES } from "../modules/registry";
/**
 * Both catalogs are keyed by module id. Completeness is enforced by
 * `tests/unit/module-labels.test.ts`, not by the compiler: enforcing it through the
 * type would require a heterogeneous literal registry and, with it, a
 * bivariant `handleEvent` — that would loosen the module contract exactly where
 * schema and handler can drift apart.
 */
type ModuleNames = Record<string, string>;

const moduleNames: LocaleCatalog<ModuleNames> = {
  de: {
    // Not a registered module (see `docs/CONTRIBUTING.md`'s `modul:host`) --
    // the worker/auth/overlay foundation events without a module of their
    // own still get a readable label instead of the raw id (issue #201).
    host: "System",
    text_commands: "Textbefehle",
    channel_events: "Kanalereignisse",
    ads: "Werbung",
    chat_voting: "Chat-Abstimmung",
    raid: "Raid-Ankündigungen & Shoutout",
    clips: "Clips",
    sun: "Sonne",
    moon: "Mond",
    weather: "Wetter",
    currency: "Währung",
    api_source: "Datenquellen",
    belabox: "BELABOX",
    statistics: "Statistiken",
    quiz: "Quiz",
    polls: "Umfragen & Predictions",
    overlay_alerts: "Overlay-Einblendungen",
    channel_points: "Kanalpunkte",
    temp_vips: "Temporäre VIPs",
  },
  en: {
    host: "System",
    text_commands: "Text commands",
    channel_events: "Channel events",
    ads: "Ad breaks",
    chat_voting: "Chat voting",
    raid: "Raid announcements & shoutout",
    clips: "Clips",
    sun: "Sun times",
    moon: "Moon data",
    weather: "Weather",
    currency: "Currency",
    api_source: "Data sources",
    belabox: "BELABOX",
    statistics: "Statistics",
    quiz: "Quiz",
    polls: "Polls & Predictions",
    overlay_alerts: "Overlay alerts",
    channel_points: "Channel points",
    temp_vips: "Temporary VIPs",
  },
};

const moduleNavigationNames: LocaleCatalog<ModuleNames> = {
  de: { raid: "Raid & Shoutout" },
  en: { raid: "Raid & shoutout" },
};

const moduleText = (catalog: Record<string, string>, moduleId: string): string | null =>
  catalogString(catalog, moduleId) ?? null;

export const moduleName = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): string => {
  const registered = MODULES.find((module) => module.id === moduleId)?.navigationEntries?.[0]?.label[language];
  return moduleText(moduleNames[language], moduleId) ?? registered ?? moduleId;
};

export const moduleNavigationName = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): string =>
  moduleText(moduleNavigationNames[language], moduleId) ?? moduleName(moduleId, language);

interface EventSubscriptionNames {
  chatMessages: string;
  chatNotifications: string;
  raids: string;
  raidIncoming: string;
  raidOutgoing: string;
  shoutoutsSent: string;
  shoutoutsReceived: string;
  moderation: string;
  automodHolds: string;
  suspiciousMessages: string;
  suspiciousClassifications: string;
  adBreaks: string;
  channelUpdates: string;
  streamStarted: string;
  streamEnded: string;
  vipRemovals: string;
  polls: string;
  predictions: string;
  channelPointsRewards: string;
  channelPointsRedemptions: string;
}

const eventSubscriptionNames: LocaleCatalog<EventSubscriptionNames> = {
  de: {
    chatMessages: "Chat-Nachrichten",
    chatNotifications: "Chat-Benachrichtigungen",
    raids: "Raids",
    raidIncoming: "Eingehende Raids",
    raidOutgoing: "Ausgehende Raids",
    shoutoutsSent: "Gesendete Shoutouts",
    shoutoutsReceived: "Empfangene Shoutouts",
    moderation: "Moderationsereignisse",
    automodHolds: "AutoMod-Haltevorgänge",
    suspiciousMessages: "Nachrichten auffälliger Nutzer",
    suspiciousClassifications: "Einstufungen auffälliger Nutzer",
    adBreaks: "Werbepausen",
    channelUpdates: "Kanaländerungen",
    streamStarted: "Streamstarts",
    streamEnded: "Streamenden",
    vipRemovals: "VIP-Entzüge",
    polls: "Umfragen",
    predictions: "Predictions",
    channelPointsRewards: "Kanalpunkt-Belohnungen",
    channelPointsRedemptions: "Kanalpunkt-Einlösungen",
  },
  en: {
    chatMessages: "Chat messages",
    chatNotifications: "Chat notifications",
    raids: "Raids",
    raidIncoming: "Incoming raids",
    raidOutgoing: "Outgoing raids",
    shoutoutsSent: "Sent shoutouts",
    shoutoutsReceived: "Received shoutouts",
    moderation: "Moderation events",
    automodHolds: "AutoMod holds",
    suspiciousMessages: "Suspicious user messages",
    suspiciousClassifications: "Suspicious user classifications",
    adBreaks: "Ad breaks",
    channelUpdates: "Channel updates",
    streamStarted: "Stream starts",
    streamEnded: "Stream ends",
    vipRemovals: "VIP removals",
    polls: "Polls",
    predictions: "Predictions",
    channelPointsRewards: "Channel point rewards",
    channelPointsRedemptions: "Channel point redemptions",
  },
};

export const eventSubName = (
  subscriptionType: string,
  variant = "",
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const texts = eventSubscriptionNames[language];
  if (subscriptionType === "channel.chat.message") return texts.chatMessages;
  if (subscriptionType === "channel.chat.notification") return texts.chatNotifications;
  if (subscriptionType === "channel.raid") {
    if (variant === "incoming") return texts.raidIncoming;
    if (variant === "outgoing") return texts.raidOutgoing;
    return texts.raids;
  }
  if (subscriptionType === "channel.shoutout.create") return texts.shoutoutsSent;
  if (subscriptionType === "channel.shoutout.receive") return texts.shoutoutsReceived;
  if (subscriptionType === "channel.moderate") return texts.moderation;
  if (subscriptionType === "automod.message.hold") return texts.automodHolds;
  if (subscriptionType === "channel.suspicious_user.message") return texts.suspiciousMessages;
  if (subscriptionType === "channel.suspicious_user.update") return texts.suspiciousClassifications;
  if (subscriptionType === "channel.ad_break.begin") return texts.adBreaks;
  if (subscriptionType === "channel.update") return texts.channelUpdates;
  if (subscriptionType === "channel.vip.remove") return texts.vipRemovals;
  if (subscriptionType.startsWith("channel.poll.")) return texts.polls;
  if (subscriptionType.startsWith("channel.prediction.")) return texts.predictions;
  if (subscriptionType.startsWith("channel.channel_points_custom_reward_redemption.")) return texts.channelPointsRedemptions;
  if (subscriptionType.startsWith("channel.channel_points_custom_reward.")) return texts.channelPointsRewards;
  if (subscriptionType === "stream.online") return texts.streamStarted;
  if (subscriptionType === "stream.offline") return texts.streamEnded;
  return subscriptionType;
};

type ModuleDescriptions = Record<string, string>;

const moduleDescriptions: LocaleCatalog<ModuleDescriptions> = {
  de: {
    text_commands: "Antwortet auf kurze Befehle im Chat.",
    channel_events: "Protokolliert, was im Kanal geschieht.",
    ads: "Kündigt beginnende Werbepausen im Chat an.",
    chat_voting: "Startet Chat-Abstimmungen und zeigt den Stimmenstand im Overlay.",
    raid: "Begrüßt eingehende Raids und ermöglicht manuelle Shoutouts.",
    clips: "Erstellt manuell einen Clip des laufenden Streams.",
    sun: "Berechnet Sonnenaufgang, Sonnenuntergang und Dämmerung für den Kanalstandort.",
    moon: "Berechnet Mondphase, Beleuchtung sowie Mondauf- und -untergang für den Kanalstandort.",
    weather: "Zeigt aktuelles Wetter für den Kanalstandort oder einen Ort im Chatbefehl.",
    currency: "Wandelt Beträge mit dem aktuellen Wechselkurs um.",
    api_source: "Liest öffentliche Webadressen aus und stellt ihre Werte für Chatbefehle bereit.",
    belabox: "Verwaltet die BELABOX-Relay-Statistikverbindung.",
    statistics: "Erfasst während des Livestreams alle fünf Minuten aggregierte Chat-, Viewer- und Chatter-Zahlen. Aktive Chatter sind die ungefähre Zahl unterschiedlicher Chatter, die in den fünf Minuten vor der Fenstergrenze geschrieben haben; ohne Stichprobe an der Grenze kann der Wert fehlen. Dafür nutzt der Bot die bestehende kurzlebige, pseudonyme Chatter-Verfolgung. Dauerhaft gespeichert werden Fenstersummen, eine kanalweite Liste der häufigsten Wörter mit Zählern (höchstens 5.000, ohne Zuordnung zu Personen oder Nachrichten) und Zeitleisten-Ereignisse je Stream (Start und Ende, Titel- und Kategoriewechsel, Clips, Werbepausen nur mit Einwilligung, Emote-Spitzen sowie eingehende und ausgehende Raids mit Kennung, Login und Anzeigenamen des Partnerkanals) samt Stream-, Kategorie- und Clip-Kennungen bis zum Löschen des Kanals; keine Namen oder Kennungen einzelner Zuschauer oder Clip-Ersteller und keine einzelnen Nachrichten.",
    quiz: "Verwaltet eigene Quiz-Fragensets für den Kanal.",
    polls: "Verwaltet vorbereitete Umfragen und Predictions und speichert Twitch-Läufe mit ihren Ergebnissen im Verlauf.",
    overlay_alerts: "Verwaltet die Medienbibliothek für Overlay-Einblendungen.",
    channel_points: "Verwaltet eigene Kanalpunkt-Belohnungen und verarbeitet Einlösungen automatisch oder für eine spätere Freigabe.",
    temp_vips: "Verwaltet VIP auf Zeit und erinnert oder entzieht es nach Ablauf.",
  },
  en: {
    text_commands: "Replies to short commands in chat.",
    channel_events: "Records what happens in the channel.",
    ads: "Announces beginning ad breaks in chat.",
    chat_voting: "Starts chat votes and shows the tally in an overlay.",
    raid: "Greets incoming raids and lets you send manual shoutouts.",
    clips: "Creates a clip from the live stream on demand.",
    sun: "Calculates sunrise, sunset, and dusk for the channel location.",
    moon: "Calculates lunar phase, illumination, moonrise, and moonset for the channel location.",
    weather: "Shows current weather for the channel location or a place in the chat command.",
    currency: "Converts amounts using the current exchange rate.",
    api_source: "Reads public web addresses and makes their values available to chat commands.",
    belabox: "Manages the BELABOX relay stats connection.",
    statistics: "Collects aggregate chat, viewer, and chatter counts every five minutes during a live stream. Active chatters approximates distinct chatters who sent a message in the five minutes before each window boundary; the value may be missing when no boundary sample was taken. It relies on the existing short-lived pseudonymous chatter tracking. Retained are window totals, a channel-wide list of the most frequent words with counts (at most 5,000, not linked to people or messages), and stream timeline events (stream start and end, title and category changes, clips, ad breaks only with consent, emote spikes, and incoming and outgoing raids with the partner channel's ID, login, and display name) including stream, category, and clip IDs until the channel is deleted; no names or IDs of individual viewers or clip creators, and no individual messages.",
    quiz: "Manage channel-owned quiz question sets.",
    polls: "Manage prepared polls and predictions and keep Twitch runs with their results in channel history.",
    overlay_alerts: "Manage the media library for overlay alerts.",
    channel_points: "Manage custom channel point rewards and process redemptions automatically or leave them queued for review.",
    temp_vips: "Manages time-limited VIPs and reminds or removes them when they expire.",
  },
};

export const moduleDescription = (
  moduleId: string,
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  const registered = MODULES.find((module) => module.id === moduleId)?.navigationEntries?.[0]?.description?.[language];
  return moduleText(moduleDescriptions[language], moduleId) ?? registered ?? null;
};

export const moduleScopePurpose = (
  moduleId: string,
  scope: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  if (moduleId === "ads" && scope === "channel:read:ads") {
    return language === "de" ? "Werbepausen erkennen" : "Detect ad breaks";
  }
  if (moduleId === "votekick" && scope === "moderation:read") {
    return language === "de" ? "Moderatoren vor Votekicks schützen" : "Protect moderators from votekicks";
  }
  if (moduleId === "channel_points" && scope === "channel:read:redemptions") {
    return language === "de" ? "Einlösungen und Belohnungen lesen" : "Read redemptions and rewards";
  }
  if (moduleId === "channel_points" && scope === "channel:manage:redemptions") {
    return language === "de" ? "Belohnungen und Einlösungen verwalten" : "Manage rewards and redemptions";
  }
  return language === "de" ? "wird vom Modul benötigt" : "required by this module";
};

interface ModuleStatus {
  running: string;
  off: string;
}

const moduleStatus: LocaleCatalog<ModuleStatus> = {
  de: { running: "Läuft", off: "Aus" },
  en: { running: "Running", off: "Off" },
};

export const statusWord = (enabled: boolean, language: DashboardLanguage = dashboardLanguage()): string => {
  const texts = moduleStatus[language];
  return enabled ? texts.running : texts.off;
};

export interface ModuleWorkspaceTexts {
  content: string;
  unknown: (name: string) => string;
  switchedOff: (name: string) => string;
  disabled: string;
  mandatoryReason: string;
  alwaysActiveStatus: string;
  noDescription: string;
  immediateDescription: string;
  activeCount: (count: number) => string;
  undo: string;
  retry: string;
  undoConflict: string;
  changed: (name: string, enabled: boolean) => string;
  activationSyncFailed: (enabled: boolean, count: number) => string;
}

const workspaceCatalog: LocaleCatalog<ModuleWorkspaceTexts> = {
  de: {
    content: "Modulinhalt",
    unknown: (name) => `Das Modul „${name}“ ist nicht bekannt.`,
    switchedOff: (name) => `Das Modul „${name}“ ist ausgeschaltet.`,
    disabled: "Deaktiviert",
    mandatoryReason: "Dieses Modul ist immer aktiv.",
    alwaysActiveStatus: "Läuft · immer aktiv",
    noDescription: "Keine Beschreibung für dieses Modul.",
    immediateDescription: "Änderungen gelten sofort. Ausgeschaltete Module behalten ihre Einstellungen.",
    activeCount: (count) => `${String(count)} aktiv`,
    undo: "Rückgängig",
    retry: "Erneut versuchen",
    undoConflict: "Inzwischen geändert",
    changed: (name, enabled) => `${name} wurde ${enabled ? "eingeschaltet" : "ausgeschaltet"}.`,
    activationSyncFailed: (enabled, count) => {
      const singular = count === 1;
      const noun = singular ? "Belohnung" : "Belohnungen";
      return `Modul ist ${enabled ? "an" : "aus"}, aber ${String(count)} ${noun} ${singular ? "konnte" : "konnten"} auf Twitch nicht ${enabled ? "aktiviert" : "deaktiviert"} werden.`;
    },
  },
  en: {
    content: "Module content",
    unknown: (name) => `The module “${name}” is unknown.`,
    switchedOff: (name) => `The module “${name}” is switched off.`,
    disabled: "Disabled",
    mandatoryReason: "This module is always active.",
    alwaysActiveStatus: "Running · always active",
    noDescription: "No description is available for this module.",
    immediateDescription: "Changes take effect immediately. Switched off modules keep their settings.",
    activeCount: (count) => `${String(count)} active`,
    undo: "Undo",
    retry: "Try again",
    undoConflict: "Changed in the meantime",
    changed: (name, enabled) => `${name} was turned ${enabled ? "on" : "off"}.`,
    activationSyncFailed: (enabled, count) => `The module is ${enabled ? "on" : "off"}, but ${String(count)} reward${count === 1 ? "" : "s"} could not be ${enabled ? "enabled" : "disabled"} on Twitch.`,
  },
};

export const moduleWorkspaceTexts = (
  language: DashboardLanguage = dashboardLanguage(),
): ModuleWorkspaceTexts => workspaceCatalog[language];
