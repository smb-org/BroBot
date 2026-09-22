import type { EventSubSubscriptionType } from "../contracts/values";
import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "./locale";
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
    text_commands: "Textbefehle",
    channel_events: "Kanalereignisse",
    ads: "Werbung",
    raid: "Raid-Shoutout",
  },
  en: {
    text_commands: "Text commands",
    channel_events: "Channel events",
    ads: "Ad breaks",
    raid: "Raid shoutout",
  },
};

const moduleText = (catalog: Record<string, string>, moduleId: string): string | null =>
  catalog[moduleId] ?? null;

export const moduleName = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): string => {
  return moduleText(moduleNames[language], moduleId) ?? moduleId;
};

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
  },
};

export const eventSubName = (
  subscriptionType: EventSubSubscriptionType,
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
  return subscriptionType;
};

type ModuleDescriptions = Record<string, string>;

const moduleDescriptions: LocaleCatalog<ModuleDescriptions> = {
  de: {
    text_commands: "Antwortet auf kurze Befehle im Chat.",
    channel_events: "Protokolliert, was im Kanal geschieht.",
    ads: "Kündigt beginnende Werbepausen im Chat an.",
    raid: "Begrüßt eingehende Raids und löst ab einer Schwelle einen Helix-Shoutout aus.",
  },
  en: {
    text_commands: "Replies to short commands in chat.",
    channel_events: "Records what happens in the channel.",
    ads: "Announces beginning ad breaks in chat.",
    raid: "Greets incoming raids and sends a Helix shoutout above a threshold.",
  },
};

export const moduleDescription = (
  moduleId: string,
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  return moduleText(moduleDescriptions[language], moduleId);
};

export type ModuleSymbol = "text_commands" | "channel_events" | "ads" | "standard";

export const moduleSymbol = (moduleId: string): ModuleSymbol => {
  if (moduleId === "text_commands") return "text_commands";
  if (moduleId === "channel_events") return "channel_events";
  if (moduleId === "ads") return "ads";
  return "standard";
};

export const moduleScopePurpose = (
  moduleId: string,
  scope: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  if (moduleId === "ads" && scope === "channel:read:ads") {
    return language === "de" ? "Werbepausen erkennen" : "Detect ad breaks";
  }
  return language === "de" ? "wird vom Modul benötigt" : "required by this module";
};

interface ModuleStatus {
  running: string;
  off: string;
  disabled: string;
}

const moduleStatus: LocaleCatalog<ModuleStatus> = {
  de: { running: "Läuft", off: "Aus", disabled: "Deaktiviert" },
  en: { running: "Running", off: "Off", disabled: "Disabled" },
};

export const statusWord = (enabled: boolean, language: DashboardLanguage = dashboardLanguage()): string => {
  const texts = moduleStatus[language];
  return enabled ? texts.running : texts.off;
};

export const disabledStatusWord = (language: DashboardLanguage = dashboardLanguage()): string => moduleStatus[language].disabled;
