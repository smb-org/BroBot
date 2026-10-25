import type { ModuleLanguage } from "../../contract";

export interface StatisticsPanelTexts {
  streams: string;
  older: string;
  loadedCount: (count: string) => string;
  noneLoaded: string;
  noSelection: string;
  emptyTitle: string;
  emptyDescription: string;
  loading: string;
  loadingDetail: string;
  loadError: string;
  detailError: string;
  retry: string;
  noTitle: string;
  noCategory: string;
  duration: string;
  durationUnit: string;
  averagePeakViewers: string;
  peakAt: string;
  messages: string;
  messagesPerMinute: string;
  activeChatters: string;
  clips: string;
  history: string;
  fiveMinuteWindows: string;
  viewerChat: string;
  chatter: string;
  bitrate: string;
  noBitrate: string;
  viewer: string;
  messagesUnit: string;
  chatterUnit: string;
  bitrateUnit: string;
  events: string;
  eventCount: (count: string) => string;
  noEvents: string;
  start: string;
  offline: string;
  streamStarted: string;
  streamEnded: string;
  metadata: string;
  clip: string;
  ad: string;
  drop: string;
  emoteSpike: string;
  emotesInWindow: (count: string) => string;
  raidIncoming: string;
  raidOutgoing: string;
  raidFrom: (name: string, viewers: string) => string;
  raidTo: (name: string, viewers: string) => string;
  title: string;
  category: string;
  at: string;
  chartFocus: string;
}

const texts: Readonly<Record<ModuleLanguage, StatisticsPanelTexts>> = {
  de: {
    streams: "Streams",
    older: "Ältere laden",
    loadedCount: (count) => `${count} geladen`,
    noneLoaded: "Noch keine geladen",
    noSelection: "Kein Stream ausgewählt. Sobald der erste Stream erfasst ist, erscheint er links in der Liste.",
    emptyTitle: "Noch keine Streams erfasst",
    emptyDescription: "Sobald der Kanal live ist, erscheinen hier aggregierte Fünf-Minuten-Fenster mit Verlauf und Ereignissen.",
    loading: "Streams werden geladen …",
    loadingDetail: "Stream-Verlauf wird geladen …",
    loadError: "Die Streams konnten nicht geladen werden.",
    detailError: "Der Stream-Verlauf konnte nicht geladen werden.",
    retry: "Erneut laden",
    noTitle: "Ohne Titel",
    noCategory: "Ohne Kategorie",
    duration: "Dauer",
    durationUnit: "h",
    averagePeakViewers: "Ø / Spitze Viewer",
    peakAt: "Spitze um",
    messages: "Nachrichten",
    messagesPerMinute: "Nachrichten / Min",
    activeChatters: "Ø aktive Chatter",
    clips: "Clips",
    history: "Verlauf",
    fiveMinuteWindows: "Je Fenster von 5 Minuten",
    viewerChat: "Viewer + Chat",
    chatter: "Chatter",
    bitrate: "Bitrate",
    noBitrate: "Keine BELABOX-Messwerte für diesen Stream-Zeitraum.",
    viewer: "Viewer",
    messagesUnit: "Nachrichten / 5 Min.",
    chatterUnit: "Chatter",
    bitrateUnit: "kbit/s",
    events: "Ereignisse",
    eventCount: (count) => `${count} in diesem Stream`,
    noEvents: "Keine Ereignisse in diesem Stream.",
    start: "Start",
    offline: "Ende",
    streamStarted: "Stream gestartet",
    streamEnded: "Stream beendet",
    metadata: "Kategorie & Titel",
    clip: "Clip",
    ad: "Werbung",
    drop: "Verbindungsabbruch",
    emoteSpike: "Emote-Spitze",
    emotesInWindow: (count) => `${count} Emotes in 5 Minuten`,
    raidIncoming: "Eingehender Raid",
    raidOutgoing: "Ausgehender Raid",
    raidFrom: (name, viewers) => `Raid von ${name} mit ${viewers} Zuschauern`,
    raidTo: (name, viewers) => `Raid zu ${name} mit ${viewers} Zuschauern`,
    title: "Titel",
    category: "Kategorie",
    at: "um",
    chartFocus: "Verlaufsmesswert",
  },
  en: {
    streams: "Streams",
    older: "Load older",
    loadedCount: (count) => `${count} loaded`,
    noneLoaded: "None loaded yet",
    noSelection: "No stream selected. Once the first stream is recorded, it appears in the list on the left.",
    emptyTitle: "No streams recorded yet",
    emptyDescription: "Once the channel goes live, aggregate five-minute windows, history, and events will appear here.",
    loading: "Loading streams …",
    loadingDetail: "Loading stream history …",
    loadError: "Could not load streams.",
    detailError: "Could not load stream history.",
    retry: "Reload",
    noTitle: "Untitled stream",
    noCategory: "No category",
    duration: "Duration",
    durationUnit: "h",
    averagePeakViewers: "Avg / peak viewers",
    peakAt: "Peak at",
    messages: "Messages",
    messagesPerMinute: "Messages / min",
    activeChatters: "Avg active chatters",
    clips: "Clips",
    history: "History",
    fiveMinuteWindows: "Each point is a five-minute window",
    viewerChat: "Viewer + Chat",
    chatter: "Chatter",
    bitrate: "Bitrate",
    noBitrate: "No BELABOX measurements for this stream period.",
    viewer: "Viewers",
    messagesUnit: "Messages / 5 min",
    chatterUnit: "Chatters",
    bitrateUnit: "kbps",
    events: "Events",
    eventCount: (count) => `${count} in this stream`,
    noEvents: "No events in this stream.",
    start: "Start",
    offline: "End",
    streamStarted: "Stream started",
    streamEnded: "Stream ended",
    metadata: "Category & title",
    clip: "Clip",
    ad: "Ad break",
    drop: "Connection drop",
    emoteSpike: "Emote spike",
    emotesInWindow: (count) => `${count} emotes in 5 minutes`,
    raidIncoming: "Incoming raid",
    raidOutgoing: "Outgoing raid",
    raidFrom: (name, viewers) => `Raid from ${name} with ${viewers} viewers`,
    raidTo: (name, viewers) => `Raid to ${name} with ${viewers} viewers`,
    title: "Title",
    category: "Category",
    at: "at",
    chartFocus: "History metric",
  },
};

export const statisticsPanelTexts = (language: ModuleLanguage): StatisticsPanelTexts => texts[language];

export interface StatisticsTrendsTexts {
  rangeSwitch: string;
  weeks: (count: number) => string;
  rangeSummary: (current: string, previous: string) => string;
  kpis: string;
  categories: string;
  streams: string;
  streamHours: string;
  averageViewers: string;
  messagesPerMinute: string;
  previous: (value: string) => string;
  noPrevious: string;
  weekPrefix: string;
  weeklyTitle: string;
  weeklyDescription: string;
  viewers: string;
  hours: string;
  leftAxis: string;
  rightAxis: string;
  emptyWeek: string;
  noStreamsInPeriod: string;
  noStreamsDescription: string;
  heatmapTitle: string;
  heatmapDescription: string;
  noStream: string;
  minViewers: string;
  maxViewers: string;
  categoriesTitle: (count: number) => string;
  category: string;
  categoryShort: string;
  categoryStreams: string;
  categoryStreamsShort: string;
  categoryHours: string;
  categoryViewers: string;
  categoryMessagesPerMinute: string;
  categoryHoursShort: string;
  categoryViewersShort: string;
  categoryMessagesShort: string;
  noCategories: string;
  loadError: string;
  retry: string;
}

const trendsTexts: Readonly<Record<ModuleLanguage, StatisticsTrendsTexts>> = {
  de: {
    rangeSwitch: "Zeitraum",
    weeks: (count) => `${String(count)} Wochen`,
    rangeSummary: (current, previous) => `${current} · verglichen mit ${previous}`,
    kpis: "Kennzahlen",
    categories: "Kategorien",
    streams: "Streams",
    streamHours: "Streamstunden",
    averageViewers: "Ø Viewer",
    messagesPerMinute: "Nachrichten / Min",
    previous: (value) => `vorher ${value}`,
    noPrevious: "kein Vergleichswert",
    weekPrefix: "KW",
    weeklyTitle: "Wochenverlauf",
    weeklyDescription: "Ø Viewer je Woche und Streamstunden",
    viewers: "Ø Viewer",
    hours: "Streamstunden",
    leftAxis: "linke Achse",
    rightAxis: "rechte Achse",
    emptyWeek: "Woche ohne Stream",
    noStreamsInPeriod: "Keine Streams in diesem Zeitraum",
    noStreamsDescription: "Hier erscheinen Wochenverlauf, Startzeiten und Kategorien, sobald Streams erfasst wurden.",
    heatmapTitle: "Wochentag × Startstunde",
    heatmapDescription: "Ø Viewer je Streamstart",
    noStream: "Kein Stream",
    minViewers: "Weniger Viewer",
    maxViewers: "Mehr Viewer",
    categoriesTitle: (count) => `${String(count)} Kategorien im Zeitraum`,
    category: "Kategorie",
    categoryShort: "Kat.",
    categoryStreams: "Streams",
    categoryStreamsShort: "St.",
    categoryHours: "Stunden",
    categoryViewers: "Ø Viewer",
    categoryMessagesPerMinute: "Ø Nachrichten / Min",
    categoryHoursShort: "Std.",
    categoryViewersShort: "Ø View.",
    categoryMessagesShort: "Ø N/Min",
    noCategories: "Keine Kategorien in diesem Zeitraum erfasst.",
    loadError: "Die Trends konnten nicht geladen werden.",
    retry: "Erneut laden",
  },
  en: {
    rangeSwitch: "Date range",
    weeks: (count) => `${String(count)} weeks`,
    rangeSummary: (current, previous) => `${current} · compared with ${previous}`,
    kpis: "Key metrics",
    categories: "Categories",
    streams: "Streams",
    streamHours: "Stream hours",
    averageViewers: "Avg viewers",
    messagesPerMinute: "Messages / min",
    previous: (value) => `before ${value}`,
    noPrevious: "no comparison value",
    weekPrefix: "Week",
    weeklyTitle: "Weekly activity",
    weeklyDescription: "Avg viewers per week and stream hours",
    viewers: "Avg viewers",
    hours: "Stream hours",
    leftAxis: "left axis",
    rightAxis: "right axis",
    emptyWeek: "Week without streams",
    noStreamsInPeriod: "No streams in this period",
    noStreamsDescription: "Weekly activity, start times, and categories will appear here once streams are recorded.",
    heatmapTitle: "Weekday × start hour",
    heatmapDescription: "Avg viewers by stream start",
    noStream: "No stream",
    minViewers: "Fewer viewers",
    maxViewers: "More viewers",
    categoriesTitle: (count) => `${String(count)} categories in this period`,
    category: "Category",
    categoryShort: "Cat.",
    categoryStreams: "Streams",
    categoryStreamsShort: "Str.",
    categoryHours: "Hours",
    categoryViewers: "Avg viewers",
    categoryMessagesPerMinute: "Avg messages / min",
    categoryHoursShort: "h",
    categoryViewersShort: "Avg.",
    categoryMessagesShort: "Msg/min",
    noCategories: "No categories recorded in this period.",
    loadError: "Could not load trends.",
    retry: "Reload",
  },
};

export const statisticsTrendsTexts = (language: ModuleLanguage): StatisticsTrendsTexts => trendsTexts[language];
