import type { TemplateVariable } from "../../contract";
import { blitzTexts } from "../locale";

const de = blitzTexts("de");
const en = blitzTexts("en");

export const BLITZ_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  {
    name: "blitz.type", maxLength: 16, sample: "word scramble", contexts: ["event"],
    picker: { de: { label: de.roundTypeVariableLabel, description: de.roundTypeVariableDescription }, en: { label: en.roundTypeVariableLabel, description: en.roundTypeVariableDescription } },
  },
  {
    name: "blitz.prompt", maxLength: 120, sample: "CLOUD", contexts: ["event"],
    picker: { de: { label: de.promptVariableLabel, description: de.promptVariableDescription }, en: { label: en.promptVariableLabel, description: en.promptVariableDescription } },
  },
  {
    name: "blitz.answer", maxLength: 60, sample: "LANTERN", contexts: ["event"],
    picker: { de: { label: de.answerVariableLabel, description: de.answerVariableDescription }, en: { label: en.answerVariableLabel, description: en.answerVariableDescription } },
  },
  {
    name: "blitz.prize", maxLength: 5, sample: "50", contexts: ["event"],
    picker: { de: { label: de.prizeVariableLabel, description: de.prizeVariableDescription }, en: { label: en.prizeVariableLabel, description: en.prizeVariableDescription } },
  },
  {
    name: "blitz.seconds", maxLength: 3, sample: "60", contexts: ["event"],
    picker: { de: { label: de.secondsVariableLabel, description: de.secondsVariableDescription }, en: { label: en.secondsVariableLabel, description: en.secondsVariableDescription } },
  },
  {
    name: "blitz.winners", maxLength: 160, sample: "silverfern, cloudberry", contexts: ["event"],
    picker: { de: { label: de.winnersVariableLabel, description: de.winnersVariableDescription }, en: { label: en.winnersVariableLabel, description: en.winnersVariableDescription } },
  },
  {
    name: "blitz.share", maxLength: 5, sample: "25", contexts: ["event"],
    picker: { de: { label: de.shareVariableLabel, description: de.shareVariableDescription }, en: { label: en.shareVariableLabel, description: en.shareVariableDescription } },
  },
];

export const BLITZ_TEMPLATE_FIELDS = {
  startText: BLITZ_TEMPLATE_VARIABLES,
  solvedText: BLITZ_TEMPLATE_VARIABLES,
  timeoutText: BLITZ_TEMPLATE_VARIABLES,
} as const;

export const blitzTemplateVariableGroup = {
  label: { de: de.title, en: en.title },
  icon: { paths: ["M13 2 4 14h7l-1 8 10-13h-7l1-7Z"] },
  order: 42,
} as const;
