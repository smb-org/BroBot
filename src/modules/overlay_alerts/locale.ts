export const overlayAlertsActionTexts = {
  de: {
    name: "Einblendung zeigen",
    invalidConfig: "Die Einblendung ist ungültig oder verweist auf nicht verfügbare Medien.",
    overlayNotConnected: "Overlay nicht verbunden.",
    emptyAlert: "Einblendung hätte keinen Inhalt.",
  },
  en: {
    name: "Show alert",
    invalidConfig: "This alert is invalid or refers to unavailable media.",
    overlayNotConnected: "Overlay not connected.",
    emptyAlert: "Alert would be empty.",
  },
} as const;

export const overlayAlertEditorTexts = {
  de: {
    image: "Bild",
    sound: "Sound",
    noImage: "Kein Bild",
    noSound: "Kein Sound",
    loading: "Medien werden geladen …",
    loadFailed: "Medien konnten nicht geladen werden.",
    mediaLink: "Medienbibliothek öffnen",
    text: "Textvorlage",
    textHint: "Optional mit Bild oder Sound.",
    placeholders: "Platzhalter einfügen",
    duration: "Anzeigedauer",
    durationUnit: "s",
    volume: "Lautstärke",
    volumeUnit: "%",
    insertPlaceholder: (value: string) => `Platzhalter ${value} einfügen`,
  },
  en: {
    image: "Image",
    sound: "Sound",
    noImage: "No image",
    noSound: "No sound",
    loading: "Loading media …",
    loadFailed: "Media could not be loaded.",
    mediaLink: "Open media library",
    text: "Text template",
    textHint: "Optional with image or sound.",
    placeholders: "Insert placeholders",
    duration: "Display duration",
    durationUnit: "s",
    volume: "Volume",
    volumeUnit: "%",
    insertPlaceholder: (value: string) => `Insert ${value} placeholder`,
  },
} as const;

