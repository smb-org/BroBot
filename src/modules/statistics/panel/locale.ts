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
    title: "Title",
    category: "Category",
    at: "at",
    chartFocus: "History metric",
  },
};

export const statisticsPanelTexts = (language: ModuleLanguage): StatisticsPanelTexts => texts[language];
