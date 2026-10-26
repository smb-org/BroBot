import type { ModuleTemplateVariableGroup, TemplateFields, TemplateVariable } from "../../contract";
import { heistCatalog } from "../locale";
import type { HeistSettings } from "../contracts";

const de = heistCatalog.de;
const en = heistCatalog.en;

const seconds: TemplateVariable = {
  name: "heist.seconds", maxLength: 3, sample: "60", contexts: ["event"],
  picker: { de: { label: de.joinWindowVariableLabel, description: de.joinWindowVariableDescription }, en: { label: en.joinWindowVariableLabel, description: en.joinWindowVariableDescription } },
};
const count: TemplateVariable = {
  name: "heist.count", maxLength: 5, sample: "3", contexts: ["event"],
  picker: { de: { label: de.countVariableLabel, description: de.countVariableDescription }, en: { label: en.countVariableLabel, description: en.countVariableDescription } },
};
const names: TemplateVariable = {
  name: "heist.names", maxLength: 160, sample: "frostfern, moonmoss, starling", contexts: ["event"],
  picker: { de: { label: de.namesVariableLabel, description: de.namesVariableDescription }, en: { label: en.namesVariableLabel, description: en.namesVariableDescription } },
};
const pot: TemplateVariable = {
  name: "heist.pot", maxLength: 12, sample: "225", contexts: ["event"],
  picker: { de: { label: de.potVariableLabel, description: de.potVariableDescription }, en: { label: en.potVariableLabel, description: en.potVariableDescription } },
};
const chance: TemplateVariable = {
  name: "heist.chance", maxLength: 3, sample: "54", contexts: ["event"],
  picker: { de: { label: de.chanceVariableLabel, description: de.chanceVariableDescription }, en: { label: en.chanceVariableLabel, description: en.chanceVariableDescription } },
};
const winners: TemplateVariable = {
  name: "heist.winners", maxLength: 160, sample: "frostfern, moonmoss", contexts: ["event"],
  picker: { de: { label: de.winnersVariableLabel, description: de.winnersVariableDescription }, en: { label: en.winnersVariableLabel, description: en.winnersVariableDescription } },
};
const losers: TemplateVariable = {
  name: "heist.losers", maxLength: 160, sample: "starling", contexts: ["event"],
  picker: { de: { label: de.losersVariableLabel, description: de.losersVariableDescription }, en: { label: en.losersVariableLabel, description: en.losersVariableDescription } },
};

/** Each message is rendered with exactly these values; the editor preview uses their samples. */
export const HEIST_TEMPLATE_FIELDS = {
  startText: [seconds],
  confirmText: [count, names, pot],
  resultText: [winners, losers, chance],
} as const satisfies TemplateFields<HeistSettings>;

export const HEIST_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  ...HEIST_TEMPLATE_FIELDS.startText,
  ...HEIST_TEMPLATE_FIELDS.confirmText,
  ...HEIST_TEMPLATE_FIELDS.resultText,
];

export const heistTemplateVariableGroup: ModuleTemplateVariableGroup = {
  label: { de: de.title, en: en.title },
  icon: { paths: ["M3 10h18M5 10V5l7-3 7 3v5M5 10v10h14V10M9 20v-6h6v6"] },
  order: 44,
};
