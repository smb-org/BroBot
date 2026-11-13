import type { ModuleLanguage } from "../../contract";
import type { ChipsInputMessages } from "../../../dashboard/ui";

export interface StatisticsWordsPanelTexts {
  title: string;
  search: string;
  clearSearch: string;
  searchPlaceholder: string;
  scope: string;
  thisStream: string;
  totalScope: string;
  hideFillers: string;
  privacyNote: string;
  ignoredWordsTitle: string;
  hiddenWordsButton: (count: string) => string;
  ignoredWordsDescription: string;
  ignoredWordsLabel: string;
  ignoredWordsPlaceholder: string;
  ignoredWordsList: string;
  removeIgnoredWord: (word: string) => string;
  ignoredWordsMessages: ChipsInputMessages;
  ignoredWordsLimit: string;
  wordCommandSettingsButton: (token: string) => string;
  wordCommandSettingsTitle: string;
  wordCommandSettingsDescription: string;
  wordCommandEnabled: string;
  wordCommandEnabledDescription: string;
  wordCommandToken: string;
  wordCommandTokenHint: string;
  wordCommandTokenError: string;
  wordCommandCooldown: string;
  wordCommandUserCooldown: string;
  wordCommandMinimumStatus: string;
  chatStatusEveryone: string;
  chatStatusSubscriber: string;
  chatStatusVip: string;
  chatStatusModerator: string;
  chatStatusBroadcaster: string;
  save: string;
  discard: string;
  saved: string;
  saving: string;
  settingsSaveError: string;
  settingsConflict: string;
  settingsLoadError: string;
  retrySettings: string;
  pageSummary: (start: string, end: string, total: string) => string;
  previousPage: string;
  nextPage: string;
  rank: string;
  rankContext: string;
  word: string;
  count: string;
  share: string;
  lastSeen: string;
  emptyTitle: string;
  emptyDescription: string;
  noMatchesTitle: string;
  noMatchesDescription: string;
  loadError: string;
  retry: string;
  shareBar: (share: string) => string;
}

const texts: Readonly<Record<ModuleLanguage, StatisticsWordsPanelTexts>> = {
  de: {
    title: "Häufigste Wörter im Chat",
    search: "Wörter suchen",
    clearSearch: "Suche löschen",
    searchPlaceholder: "Wort suchen",
    scope: "Zeitraum",
    thisStream: "Dieser Stream",
    totalScope: "Insgesamt",
    hideFillers: "Füllwörter ausblenden",
    privacyNote: "Kanalweit, ohne Zuordnung zu Personen oder Nachrichten.",
    ignoredWordsTitle: "Ausgeblendete Wörter",
    hiddenWordsButton: (count) => `Ausgeblendet · ${count}`,
    ignoredWordsDescription: "Ausgeblendete Wörter bleiben gespeichert und erscheinen wieder, wenn du sie entfernst.",
    ignoredWordsLabel: "Wörter hinzufügen oder entfernen",
    ignoredWordsPlaceholder: "Wort eingeben und Enter drücken",
    ignoredWordsList: "Ausgeblendete Wörter",
    removeIgnoredWord: (word) => `${word} entfernen`,
    ignoredWordsMessages: {
      countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
      atLimitHint: "Du kannst höchstens 200 Wörter ausblenden.",
      duplicateWarning: (entry) => `${entry} ist bereits ausgeblendet.`,
    },
    ignoredWordsLimit: "Wörter dürfen höchstens 40 Zeichen lang sein.",
    wordCommandSettingsButton: (token) => `Befehl ${token}`,
    wordCommandSettingsTitle: "Wortbefehl",
    wordCommandSettingsDescription: "Aktiviere den Chatbefehl und lege Zugriffsstatus sowie Abklingzeiten fest.",
    wordCommandEnabled: "Wortbefehl aktivieren",
    wordCommandEnabledDescription: "Erlaubt den Chatbefehl, der Wortzählungen anzeigt.",
    wordCommandToken: "Befehl",
    wordCommandTokenHint: "Ein einzelner Befehl wie !wort.",
    wordCommandTokenError: "Verwende ! gefolgt von 2 bis 24 Buchstaben, Zahlen oder Unterstrichen.",
    wordCommandCooldown: "Globale Abklingzeit",
    wordCommandUserCooldown: "Abklingzeit pro Person",
    wordCommandMinimumStatus: "Mindeststatus im Chat",
    chatStatusEveryone: "Alle",
    chatStatusSubscriber: "Abonnenten",
    chatStatusVip: "VIPs",
    chatStatusModerator: "Moderatoren",
    chatStatusBroadcaster: "Broadcaster",
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Einstellungen gespeichert.",
    saving: "Speichern …",
    settingsSaveError: "Die Einstellungen konnten nicht gespeichert werden.",
    settingsConflict: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.",
    settingsLoadError: "Die Einstellungen konnten nicht geladen werden.",
    retrySettings: "Erneut laden",
    pageSummary: (start, end, total) => `${start}–${end} von ${total}`,
    previousPage: "Vorherige Seite",
    nextPage: "Nächste Seite",
    rank: "Rang",
    rankContext: "Rang innerhalb der gefilterten Ergebnisliste.",
    word: "Wort",
    count: "Zähler",
    share: "Anteil",
    lastSeen: "Zuletzt gesehen",
    emptyTitle: "Noch keine Wörter erfasst",
    emptyDescription: "Sobald der Kanal live ist, werden hier häufige Chat-Wörter gesammelt.",
    noMatchesTitle: "Keine passenden Wörter",
    noMatchesDescription: "Ändere den Suchbegriff oder blende Füllwörter ein.",
    loadError: "Die Wörter konnten nicht geladen werden.",
    retry: "Erneut laden",
    shareBar: (share) => `Relativer Zählerbalken. Anteil aller gespeicherten Wortzählungen: ${share}`,
  },
  en: {
    title: "Most frequent chat words",
    search: "Search words",
    clearSearch: "Clear search",
    searchPlaceholder: "Search for a word",
    scope: "Range",
    thisStream: "This stream",
    totalScope: "Total",
    hideFillers: "Hide filler words",
    privacyNote: "Channel-wide, with no link to people or messages.",
    ignoredWordsTitle: "Hidden words",
    hiddenWordsButton: (count) => `Hidden · ${count}`,
    ignoredWordsDescription: "Hidden words stay stored and return to the list when you remove them here.",
    ignoredWordsLabel: "Add or remove words",
    ignoredWordsPlaceholder: "Enter a word and press Enter",
    ignoredWordsList: "Hidden words",
    removeIgnoredWord: (word) => `Remove ${word}`,
    ignoredWordsMessages: {
      countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
      atLimitHint: "You can hide up to 200 words.",
      duplicateWarning: (entry) => `${entry} is already hidden.`,
    },
    ignoredWordsLimit: "Words can be up to 40 characters long.",
    wordCommandSettingsButton: (token) => `Command ${token}`,
    wordCommandSettingsTitle: "Word command",
    wordCommandSettingsDescription: "Enable the chat command and set its access level and cooldowns.",
    wordCommandEnabled: "Enable word command",
    wordCommandEnabledDescription: "Allows chat to request word counts.",
    wordCommandToken: "Command token",
    wordCommandTokenHint: "One command token, such as !wort.",
    wordCommandTokenError: "Use ! followed by 2 to 24 letters, numbers, or underscores.",
    wordCommandCooldown: "Global cooldown",
    wordCommandUserCooldown: "Per-user cooldown",
    wordCommandMinimumStatus: "Minimum chat status",
    chatStatusEveryone: "Everyone",
    chatStatusSubscriber: "Subscribers",
    chatStatusVip: "VIPs",
    chatStatusModerator: "Moderators",
    chatStatusBroadcaster: "Broadcaster",
    save: "Save",
    discard: "Discard",
    saved: "Settings saved.",
    saving: "Saving …",
    settingsSaveError: "Could not save settings.",
    settingsConflict: "Settings changed while you were editing. Reload and try again.",
    settingsLoadError: "Could not load settings.",
    retrySettings: "Reload",
    pageSummary: (start, end, total) => `${start}–${end} of ${total}`,
    previousPage: "Previous page",
    nextPage: "Next page",
    rank: "Rank",
    rankContext: "Rank within the filtered result list.",
    word: "Word",
    count: "Count",
    share: "Share",
    lastSeen: "Last seen",
    emptyTitle: "No words recorded yet",
    emptyDescription: "Once the channel is live, frequently used chat words will appear here.",
    noMatchesTitle: "No matching words",
    noMatchesDescription: "Change the search or show filler words.",
    loadError: "Could not load the words.",
    retry: "Reload",
    shareBar: (share) => `Relative count bar. Share of all stored word counts: ${share}`,
  },
};

export const statisticsWordsPanelTexts = (language: ModuleLanguage): StatisticsWordsPanelTexts => texts[language];
