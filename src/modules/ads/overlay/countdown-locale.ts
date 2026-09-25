export const adsCountdownLabels = (language: "de" | "en") => language === "de"
  ? {
    adIn: "Werbung in",
    adRunning: "Werbung läuft",
    snoozesLeft: (count: number) => `${String(count)}× verschiebbar`,
    nextSnoozeIn: "nächster Snooze in",
    snoozeAvailable: "Snooze verfügbar",
    sample: "Beispiel",
    showSnoozeInfo: "Snooze-Info anzeigen",
  }
  : {
    adIn: "Ad in",
    adRunning: "Ad running",
    snoozesLeft: (count: number) => `${String(count)} snoozes left`,
    nextSnoozeIn: "next snooze in",
    snoozeAvailable: "Snooze available",
    sample: "Sample",
    showSnoozeInfo: "Show snooze info",
  };
