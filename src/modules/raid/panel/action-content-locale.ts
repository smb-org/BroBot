import type { ModuleLanguage } from "../../contract";

export const raidActionContentTexts = {
  channelName: { de: "Kanalname", en: "Channel name" },
  channelHint: {
    de: "Kanal-Login eingeben oder Vorschlag wählen; ein führendes @ wird entfernt.",
    en: "Enter a channel login or choose a suggestion; a leading @ is removed.",
  },
  channelRequired: { de: "Kanalname eingeben", en: "Enter a channel name" },
  run: { de: "Ausführen", en: "Run" },
  running: { de: "Wird ausgeführt …", en: "Running …" },
} as const satisfies Readonly<Record<"channelName" | "channelHint" | "channelRequired" | "run" | "running", Readonly<Record<ModuleLanguage, string>>>>;
