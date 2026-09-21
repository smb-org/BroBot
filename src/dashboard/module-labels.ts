import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "./locale";
/**
 * Beide Kataloge sind nach Modulkennung geschlüsselt. Die Vollständigkeit
 * sichert `tests/unit/module-labels.test.ts`, nicht der Compiler: Sie über den
 * Typ zu erzwingen, verlangte eine heterogene Literal-Registry und damit einen
 * bivarianten `handleEvent` — das lockerte den Modulvertrag an der Stelle, an
 * der Schema und Handler auseinanderlaufen können.
 */
type ModulNamen = Record<string, string>;

const modulNamen: LocaleCatalog<ModulNamen> = {
  de: {
    textbefehle: "Textbefehle",
    kanalereignisse: "Kanalereignisse",
    werbung: "Werbung",
    raid: "Raid-Shoutout",
  },
  en: {
    textbefehle: "Text commands",
    kanalereignisse: "Channel events",
    werbung: "Ad breaks",
    raid: "Raid shoutout",
  },
};

const modulText = (catalog: Record<string, string>, moduleId: string): string | null =>
  catalog[moduleId] ?? null;

export const moduleName = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): string => {
  return modulText(modulNamen[language], moduleId) ?? moduleId;
};

interface EreignisAboNamen {
  chatNachrichten: string;
  chatBenachrichtigungen: string;
  raids: string;
  raidEingehend: string;
  raidAusgehend: string;
  shoutoutsGesendet: string;
  shoutoutsEmpfangen: string;
  moderation: string;
  automodHalte: string;
  verdachtNachrichten: string;
  verdachtEinstufungen: string;
  werbung: string;
}

const ereignisAboNamen: LocaleCatalog<EreignisAboNamen> = {
  de: {
    chatNachrichten: "Chat-Nachrichten",
    chatBenachrichtigungen: "Chat-Benachrichtigungen",
    raids: "Raids",
    raidEingehend: "Eingehende Raids",
    raidAusgehend: "Ausgehende Raids",
    shoutoutsGesendet: "Gesendete Shoutouts",
    shoutoutsEmpfangen: "Empfangene Shoutouts",
    moderation: "Moderationsereignisse",
    automodHalte: "AutoMod-Haltevorgänge",
    verdachtNachrichten: "Nachrichten auffälliger Nutzer",
    verdachtEinstufungen: "Einstufungen auffälliger Nutzer",
    werbung: "Werbepausen",
  },
  en: {
    chatNachrichten: "Chat messages",
    chatBenachrichtigungen: "Chat notifications",
    raids: "Raids",
    raidEingehend: "Incoming raids",
    raidAusgehend: "Outgoing raids",
    shoutoutsGesendet: "Sent shoutouts",
    shoutoutsEmpfangen: "Received shoutouts",
    moderation: "Moderation events",
    automodHalte: "AutoMod holds",
    verdachtNachrichten: "Suspicious user messages",
    verdachtEinstufungen: "Suspicious user classifications",
    werbung: "Ad breaks",
  },
};

export const eventSubName = (
  subscriptionType: string,
  variant = "",
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  const texte = ereignisAboNamen[language];
  if (subscriptionType === "channel.chat.message") return texte.chatNachrichten;
  if (subscriptionType === "channel.chat.notification") return texte.chatBenachrichtigungen;
  if (subscriptionType === "channel.raid") {
    if (variant === "eingehend") return texte.raidEingehend;
    if (variant === "ausgehend") return texte.raidAusgehend;
    return texte.raids;
  }
  if (subscriptionType === "channel.shoutout.create") return texte.shoutoutsGesendet;
  if (subscriptionType === "channel.shoutout.receive") return texte.shoutoutsEmpfangen;
  if (subscriptionType === "channel.moderate") return texte.moderation;
  if (subscriptionType === "automod.message.hold") return texte.automodHalte;
  if (subscriptionType === "channel.suspicious_user.message") return texte.verdachtNachrichten;
  if (subscriptionType === "channel.suspicious_user.update") return texte.verdachtEinstufungen;
  if (subscriptionType === "channel.ad_break.begin") return texte.werbung;
  return subscriptionType;
};

type ModulBeschreibungen = Record<string, string>;

const modulBeschreibungen: LocaleCatalog<ModulBeschreibungen> = {
  de: {
    textbefehle: "Antwortet auf kurze Befehle im Chat.",
    kanalereignisse: "Protokolliert, was im Kanal geschieht.",
    werbung: "Kündigt beginnende Werbepausen im Chat an.",
    raid: "Begrüßt eingehende Raids und löst ab einer Schwelle einen Helix-Shoutout aus.",
  },
  en: {
    textbefehle: "Replies to short commands in chat.",
    kanalereignisse: "Records what happens in the channel.",
    werbung: "Announces beginning ad breaks in chat.",
    raid: "Greets incoming raids and sends a Helix shoutout above a threshold.",
  },
};

export const moduleDescription = (
  moduleId: string,
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  return modulText(modulBeschreibungen[language], moduleId);
};

export type ModuleSymbol = "textbefehle" | "kanalereignisse" | "werbung" | "standard";

export const moduleSymbol = (moduleId: string): ModuleSymbol => {
  if (moduleId === "textbefehle") return "textbefehle";
  if (moduleId === "kanalereignisse") return "kanalereignisse";
  if (moduleId === "werbung") return "werbung";
  return "standard";
};

export const moduleScopePurpose = (
  moduleId: string,
  scope: string,
  language: DashboardLanguage = dashboardLanguage(),
): string => {
  if (moduleId === "werbung" && scope === "channel:read:ads") {
    return language === "de" ? "Werbepausen erkennen" : "Detect ad breaks";
  }
  return language === "de" ? "wird vom Modul benötigt" : "required by this module";
};

interface ModulStatus {
  laeuft: string;
  aus: string;
  deaktiviert: string;
}

const modulStatus: LocaleCatalog<ModulStatus> = {
  de: { laeuft: "Läuft", aus: "Aus", deaktiviert: "Deaktiviert" },
  en: { laeuft: "Running", aus: "Off", deaktiviert: "Disabled" },
};

export const statusWord = (enabled: boolean, language: DashboardLanguage = dashboardLanguage()): string => {
  const texte = modulStatus[language];
  return enabled ? texte.laeuft : texte.aus;
};

export const disabledStatusWord = (language: DashboardLanguage = dashboardLanguage()): string => modulStatus[language].deaktiviert;
