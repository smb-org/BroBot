import type { ModuleLanguage } from "../../contract";

export interface StatisticsWordsPanelTexts {
  title: string;
  search: string;
  clearSearch: string;
  searchPlaceholder: string;
  hideFillers: string;
  privacyNote: string;
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
    hideFillers: "Füllwörter ausblenden",
    privacyNote: "Kanalweit, ohne Zuordnung zu Personen oder Nachrichten. Höchstens 5.000 Wörter.",
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
    hideFillers: "Hide filler words",
    privacyNote: "Channel-wide, with no link to people or messages. At most 5,000 words.",
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
