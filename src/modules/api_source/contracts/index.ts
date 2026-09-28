import type { ModuleLanguage, TemplateVariable } from "../../contract";

export const API_SOURCE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
export const API_SOURCE_MAXIMUMS = {
  sourcesPerChannel: 20,
  urlLength: 2_048,
  expressionLength: 512,
  outputLength: 2_000,
  requestsPerChannelPerHour: 100,
} as const;

export interface ApiSource {
  name: string;
  url: string;
  expression: string;
  revision: number;
  updatedAt: string;
}

export const API_SOURCE_VALUE_VARIABLE = {
  name: "api_source.value",
  group: "channel",
  maxLength: API_SOURCE_MAXIMUMS.outputLength,
  sample: "18:42",
  parameters: "api_source_name",
  parameterDefault: "sunset",
  external: true,
  picker: {
    de: { label: "API-Quelle", description: "Gibt den Wert einer benannten API-Quelle aus. Beispiel: {api_source.value sunset}" },
    en: { label: "API source", description: "Outputs the value of a named API source. Example: {api_source.value sunset}" },
  },
} as const satisfies TemplateVariable;

export const apiSourceModuleCatalog: Readonly<Record<ModuleLanguage, {
  label: string;
  description: string;
  variableGroup: string;
  unavailableText: string;
  conditionLabel: (name: string) => string;
  trueValue: string;
  falseValue: string;
  mandatoryReason: string;
}>> = {
  de: {
    label: "API-Quellen",
    description: "Eigene HTTPS-JSON-Quellen mit JSONata-Ausdrücken.",
    variableGroup: "API-Quellen",
    unavailableText: "Die API-Quelle ist derzeit nicht verfügbar.",
    conditionLabel: (name) => `API-Quelle: ${name}`,
    trueValue: "Wahr",
    falseValue: "Falsch",
    mandatoryReason: "API-Quellen stellen benannte externe Werte für Vorlagen bereit.",
  },
  en: {
    label: "API sources",
    description: "Custom HTTPS JSON sources with JSONata expressions.",
    variableGroup: "API sources",
    unavailableText: "The API source is currently unavailable.",
    conditionLabel: (name) => `API source: ${name}`,
    trueValue: "True",
    falseValue: "False",
    mandatoryReason: "API sources provide named external values for templates.",
  },
};
