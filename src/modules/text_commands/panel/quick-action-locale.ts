import type { ModuleLanguage } from "../../contract";

export const textCommandQuickActionTexts = {
  counter: {
    name: { de: "Zähler +1", en: "Counter +1" },
    paletteKeywords: ["counter", "variable", "zähler", "kanalvariable"],
    loading: { de: "Variablen werden geladen …", en: "Loading variables…" },
    noVariables: { de: "Keine numerischen Kanalvariablen verfügbar.", en: "No numeric channel variables are available." },
    loadFailed: { de: "Variablen konnten nicht geladen werden.", en: "Variables could not be loaded." },
    variableLabel: { de: "Kanalvariable", en: "Channel variable" },
    selectVariable: { de: "Variable auswählen", en: "Select a variable" },
    chooseCounterTitle: { de: "Zähler auswählen", en: "Choose counter" },
    chooseCounterDescription: { de: "Wähle die Kanalvariable aus, die erhöht werden soll.", en: "Choose the channel variable to increment." },
    success: (value: string): Readonly<Record<ModuleLanguage, string>> => ({
      de: `Neuer Wert: ${value}`,
      en: `New value: ${value}`,
    }),
    error: { de: "Der Zähler konnte nicht erhöht werden.", en: "The counter could not be incremented." },
  },
  testMessage: {
    name: { de: "Testnachricht senden", en: "Send test message" },
    chatText: { de: "Dies ist eine Testnachricht von BroBot.", en: "This is a test message from BroBot." },
    botNotConnected: { de: "Der Bot ist nicht verbunden.", en: "The bot is not connected." },
    sent: { de: "Testnachricht gesendet.", en: "Test message sent." },
    dropped: { de: "Twitch hat die Testnachricht nicht gesendet.", en: "Twitch did not send the test message." },
    identityMissing: { de: "Es ist kein Bot-Konto verbunden.", en: "No bot account is connected." },
    rateLimited: (seconds: string): Readonly<Record<ModuleLanguage, string>> => ({
      de: `Erneut in ${seconds} s`,
      en: `Retry in ${seconds} s`,
    }),
    error: { de: "Die Testnachricht konnte nicht gesendet werden.", en: "The test message could not be sent." },
  },
} as const;
