import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";
import type { TEXT_COMMAND_VARIABLES, TextCommandMinimumTier } from "../contracts";

type TextCommandVariableName = (typeof TEXT_COMMAND_VARIABLES)[number]["name"];

interface TextCommandsTexts {
  title: string;
  list: string;
  add: string;
  name: string;
  kind: string;
  kindText: string;
  kindList: string;
  text: string;
  variables: Record<TextCommandVariableName, string>;
  cooldown: string;
  minimumTier: string;
  minimumTierFor: (name: string) => string;
  minimumTierLocked: string;
  tiers: Record<TextCommandMinimumTier, string>;
  toggleLabel: (name: string, enabled: boolean) => string;
  managementLocked: string;
  save: (name: string) => string;
  delete: (name: string) => string;
  deleteTitle: (name: string) => string;
  deleteConfirmation: (name: string) => string;
  confirmDeletion: (name: string) => string;
  empty: string;
  load: string;
  error: string;
  saveError: string;
  deleteError: string;
  numberMissing: string;
  nameHint: string;
  details: (name: string) => string;
  never: string;
  secondsAgo: (count: number) => string;
  minutesAgo: (count: number) => string;
  hoursAgo: (count: number) => string;
  responseMissing: string;
  nameMissing: string;
  nameInvalid: string;
  columns: {
    name: string;
    kind: string;
    text: string;
    cooldown: string;
    last: string;
    minimumTier: string;
    active: string;
  };
}

const texts: LocaleCatalog<TextCommandsTexts> = {
  de: {
    title: "Textbefehle",
    list: "Befehle",
    add: "Befehl anlegen",
    name: "Name",
    kind: "Art",
    kindText: "Antworttext",
    kindList: "Befehlsliste",
    text: "Antworttext",
    variables: {
      user: "Name des Zuschauers, der den Befehl auslöst",
      channel: "Name des Kanals",
    },
    cooldown: "Abkühlzeit (Sekunden)",
    minimumTier: "Mindeststufe",
    minimumTierFor: (name) => `Mindeststufe für Befehl !${name}`,
    minimumTierLocked: "Nur Broadcaster und Verwalter dürfen Mindeststufen ändern.",
    tiers: { everyone: "Alle", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster" },
    toggleLabel: (name, enabled) => `Befehl !${name}: ${enabled ? "eingeschaltet" : "ausgeschaltet"}`,
    managementLocked: "Nur Broadcaster und Verwalter dürfen Befehle anlegen, bearbeiten oder löschen.",
    save: (name) => `Befehl !${name} speichern`,
    delete: (name) => `Befehl !${name} löschen`,
    deleteTitle: (name) => `Befehl !${name} löschen?`,
    deleteConfirmation: (name) => `Der Textbefehl !${name} wird dauerhaft gelöscht. Diese Handlung kann nicht rückgängig gemacht werden.`,
    confirmDeletion: (name) => `Befehl !${name} endgültig löschen`,
    empty: "Noch keine Textbefehle angelegt.",
    load: "Textbefehle werden geladen …",
    error: "Die Textbefehle konnten nicht geladen werden.",
    saveError: "Der Textbefehl konnte nicht gespeichert werden.",
    deleteError: "Der Textbefehl konnte nicht gelöscht werden.",
    numberMissing: "Zahl eingeben",
    nameHint: "Kleinbuchstaben, Zahlen, Bindestrich und Unterstrich.",
    details: (name) => `Eigenschaften von !${name}`,
    never: "noch nie",
    secondsAgo: (count) => `vor ${String(count)} s`,
    minutesAgo: (count) => `vor ${String(count)} min`,
    hoursAgo: (count) => `vor ${String(count)} h`,
    responseMissing: "Antworttext ausfüllen",
    nameMissing: "Namen ausfüllen",
    nameInvalid: "Nur Kleinbuchstaben, Zahlen, Bindestrich und Unterstrich; maximal 32 Zeichen.",
    columns: { name: "!Name", kind: "Art", text: "Antwort", cooldown: "Abkühl.", last: "Zuletzt", minimumTier: "Mindeststufe", active: "Schalter" },
  },
  en: {
    title: "Text commands",
    list: "Commands",
    add: "Add command",
    name: "Name",
    kind: "Type",
    kindText: "Response text",
    kindList: "Command list",
    text: "Response text",
    variables: {
      user: "Name of the viewer who triggered the command",
      channel: "Channel name",
    },
    cooldown: "Cooldown (seconds)",
    minimumTier: "Minimum level",
    minimumTierFor: (name) => `Minimum level for !${name}`,
    minimumTierLocked: "Only broadcasters and managers may change minimum levels.",
    tiers: { everyone: "Everyone", subscriber: "Subscribers", vip: "VIPs", moderator: "Moderators", broadcaster: "Broadcaster" },
    toggleLabel: (name, enabled) => `Command !${name}: ${enabled ? "enabled" : "disabled"}`,
    managementLocked: "Only broadcasters and managers may add, edit, or delete commands.",
    save: (name) => `Save !${name}`,
    delete: (name) => `Delete !${name}`,
    deleteTitle: (name) => `Delete !${name}?`,
    deleteConfirmation: (name) => `The text command !${name} will be deleted permanently. This action cannot be undone.`,
    confirmDeletion: (name) => `Delete !${name} permanently`,
    empty: "No text commands yet.",
    load: "Loading text commands …",
    error: "The text commands could not be loaded.",
    saveError: "The text command could not be saved.",
    deleteError: "The text command could not be deleted.",
    numberMissing: "Enter a number",
    nameHint: "Lowercase letters, numbers, hyphen and underscore.",
    details: (name) => `Properties for !${name}`,
    never: "never",
    secondsAgo: (count) => `${String(count)} s ago`,
    minutesAgo: (count) => `${String(count)} min ago`,
    hoursAgo: (count) => `${String(count)} h ago`,
    responseMissing: "Fill in a response",
    nameMissing: "Fill in a name",
    nameInvalid: "Use lowercase letters, numbers, hyphen, or underscore; maximum 32 characters.",
    columns: { name: "!Name", kind: "Type", text: "Response", cooldown: "Cooldown", last: "Last", minimumTier: "Minimum level", active: "Switch" },
  },
};

export const textCommandsTexts = (language: DashboardLanguage = dashboardLanguage()): TextCommandsTexts => texts[language];
