import type { TemplateVariable } from "../../contract";

export const VOTEKICK_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { name: "votekick.target", group: "event", contexts: ["event"], sample: "sampleviewer", maxLength: 25, picker: { de: { label: "Ziel", description: "Login des Ziels" }, en: { label: "Target", description: "Target login" } } },
  { name: "votekick.yes", group: "event", contexts: ["event"], sample: "6", maxLength: 10, picker: { de: { label: "Ja-Stimmen", description: "Anzahl der Ja-Stimmen" }, en: { label: "Yes votes", description: "Number of yes votes" } } },
  { name: "votekick.no", group: "event", contexts: ["event"], sample: "1", maxLength: 10, picker: { de: { label: "Nein-Stimmen", description: "Anzahl der Nein-Stimmen" }, en: { label: "No votes", description: "Number of no votes" } } },
  { name: "votekick.threshold", group: "event", contexts: ["event"], sample: "5", maxLength: 10, picker: { de: { label: "Schwelle", description: "Benötigte Netto-Ja-Stimmen" }, en: { label: "Threshold", description: "Required net yes votes" } } },
  { name: "votekick.seconds", group: "event", contexts: ["event"], sample: "120", maxLength: 4, picker: { de: { label: "Sekunden", description: "Timeout-Dauer in Sekunden" }, en: { label: "Seconds", description: "Timeout duration in seconds" } } },
  { name: "votekick.duration", group: "event", contexts: ["event"], sample: "2 min", maxLength: 16, picker: { de: { label: "Dauer", description: "Lesbare Timeout-Dauer" }, en: { label: "Duration", description: "Readable timeout duration" } } },
];

export const VOTEKICK_TEMPLATE_FIELDS = {
  startText: VOTEKICK_TEMPLATE_VARIABLES,
  passText: VOTEKICK_TEMPLATE_VARIABLES,
  failText: VOTEKICK_TEMPLATE_VARIABLES,
  expiredText: VOTEKICK_TEMPLATE_VARIABLES,
  protectedText: VOTEKICK_TEMPLATE_VARIABLES,
  busyText: VOTEKICK_TEMPLATE_VARIABLES,
} as const;
