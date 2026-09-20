import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "./locale";

interface ModulNamen {
  textbefehle: string;
  kanalereignisse: string;
}

const modulNamen: LocaleCatalog<ModulNamen> = {
  de: { textbefehle: "Textbefehle", kanalereignisse: "Kanalereignisse" },
  en: { textbefehle: "Text commands", kanalereignisse: "Channel events" },
};

export const moduleName = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): string => {
  if (moduleId === "textbefehle") return modulNamen[language].textbefehle;
  if (moduleId === "kanalereignisse") return modulNamen[language].kanalereignisse;
  return moduleId;
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
  return subscriptionType;
};

interface ModulBeschreibungen {
  textbefehle: string;
  kanalereignisse: string;
}

const modulBeschreibungen: LocaleCatalog<ModulBeschreibungen> = {
  de: {
    textbefehle: "Antwortet auf kurze Befehle im Chat.",
    kanalereignisse: "Protokolliert, was im Kanal geschieht.",
  },
  en: {
    textbefehle: "Replies to short commands in chat.",
    kanalereignisse: "Records what happens in the channel.",
  },
};

export const moduleDescription = (
  moduleId: string,
  language: DashboardLanguage = dashboardLanguage(),
): string | null => {
  if (moduleId === "textbefehle") return modulBeschreibungen[language].textbefehle;
  if (moduleId === "kanalereignisse") return modulBeschreibungen[language].kanalereignisse;
  return null;
};

interface ModulStatus {
  laeuft: string;
  aus: string;
}

const modulStatus: LocaleCatalog<ModulStatus> = {
  de: { laeuft: "Läuft", aus: "Aus" },
  en: { laeuft: "Running", aus: "Off" },
};

export const statusWord = (enabled: boolean, language: DashboardLanguage = dashboardLanguage()): string => {
  const texte = modulStatus[language];
  return enabled ? texte.laeuft : texte.aus;
};
