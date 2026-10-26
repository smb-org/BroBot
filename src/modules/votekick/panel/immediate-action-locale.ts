export const votekickImmediateActionTexts = {
  name: { de: "Timeout aufheben", en: "Lift timeout" },
  noActiveTimeouts: { de: "Keine offenen Votekick-Timeouts zum Aufheben.", en: "No active Votekick timeouts to lift." },
  timeoutLabel: { de: "Viewer", en: "Viewer" },
  chooseTimeout: { de: "Viewer auswählen", en: "Choose a viewer" },
  chooseTimeoutHint: { de: "Wähle einen aktiven Votekick-Timeout aus.", en: "Choose an active Votekick timeout." },
  loading: { de: "Aktive Timeouts werden geladen …", en: "Loading active timeouts…" },
  loadFailed: { de: "Aktive Timeouts konnten nicht geladen werden.", en: "Active timeouts could not be loaded." },
  selectionRequired: { de: "Wähle einen Timeout aus.", en: "Choose a timeout." },
  success: { de: "Timeout aufgehoben.", en: "Timeout lifted." },
  error: { de: "Timeout konnte nicht aufgehoben werden.", en: "The timeout could not be lifted." },
} as const;
