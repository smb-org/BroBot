export const songRequestQueueActionTexts = {
  de: {
    title: "Wartet auf Moderation",
    loading: "Warteschlange wird geladen …",
    error: "Die Warteschlange konnte nicht geladen werden.",
    empty: "Keine Song-Wünsche warten auf Prüfung.",
    approve: "Freigeben",
    reject: "Ablehnen",
    points: "Bot-Punkte",
    free: "Kostenlos",
    vote: "Abstimmung",
    channelPoints: "Kanalpunkte",
    processing: "Wird verarbeitet …",
    operationFailed: "Die Song-Anfrage konnte nicht aktualisiert werden.",
  },
  en: {
    title: "Waiting for moderation",
    loading: "Loading queue …",
    error: "The queue could not be loaded.",
    empty: "No song requests are waiting for review.",
    approve: "Approve",
    reject: "Reject",
    points: "Bot points",
    free: "Free",
    vote: "Vote",
    channelPoints: "Channel points",
    processing: "Processing …",
    operationFailed: "The song request could not be updated.",
  },
} as const;

export const songRequestQueueSubtitle = {
  de: (count: number): string => `${String(count)} Song-Wünsche warten`,
  en: (count: number): string => `${String(count)} song requests waiting`,
} as const;
