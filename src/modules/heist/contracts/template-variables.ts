import type { ModuleTemplateVariableGroup, TemplateFields, TemplateVariable } from "../../contract";
import { heistCatalog } from "../locale";
import type { HeistSettings } from "../contracts";

const de = heistCatalog.de;
const en = heistCatalog.en;

export const HEIST_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  {
    name: "heist.seconds", maxLength: 3, sample: "60", contexts: ["event"],
    picker: { de: { label: de.joinWindowVariableLabel, description: de.joinWindowVariableDescription }, en: { label: en.joinWindowVariableLabel, description: en.joinWindowVariableDescription } },
  },
  {
    name: "heist.chance", maxLength: 3, sample: "54", contexts: ["event"],
    picker: { de: { label: de.chanceVariableLabel, description: de.chanceVariableDescription }, en: { label: en.chanceVariableLabel, description: en.chanceVariableDescription } },
  },
  {
    name: "heist.winners", maxLength: 160, sample: "frostfern, moonmoss", contexts: ["event"],
    picker: { de: { label: de.winnersVariableLabel, description: de.winnersVariableDescription }, en: { label: en.winnersVariableLabel, description: en.winnersVariableDescription } },
  },
  {
    name: "heist.losers", maxLength: 160, sample: "starling", contexts: ["event"],
    picker: { de: { label: de.losersVariableLabel, description: de.losersVariableDescription }, en: { label: en.losersVariableLabel, description: en.losersVariableDescription } },
  },
];

export const HEIST_TEMPLATE_FIELDS = {
  startText: HEIST_TEMPLATE_VARIABLES,
  resultText: HEIST_TEMPLATE_VARIABLES,
} as const satisfies TemplateFields<HeistSettings>;

export const heistTemplateVariableGroup: ModuleTemplateVariableGroup = {
  label: { de: de.title, en: en.title },
  icon: { paths: ["M3 10h18M5 10V5l7-3 7 3v5M5 10v10h14V10M9 20v-6h6v6"] },
  order: 44,
};
