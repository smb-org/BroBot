import type { ModuleLanguage, TemplateVariable } from "../../contract";

export const API_SOURCE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
export type ApiSourceFailureReason =
  | "unreachable"
  | "timeout"
  | "http_error"
  | "invalid_json"
  | "invalid_expression"
  | "unsupported_expression"
  | "missing_value"
  | "invalid_url"
  | "response_too_large"
  | "redirect_error"
  | "quota_exceeded";
export type ApiSourceLastStatus = "ok" | "error";

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
  lastFetchedAt: string | null;
  lastStatus: ApiSourceLastStatus | null;
  lastError: ApiSourceFailureReason | null;
}

export type ApiSourceTestResult =
  | { status: "ok"; httpStatus: number; bytes: number; json: unknown; value: string }
  | {
    status: "error";
    reason: ApiSourceFailureReason;
    httpStatus?: number;
    constructName?: string;
  };

export const apiSourceTemplateVariable = (name: string): TemplateVariable => ({
  name: `api.${name}`,
  group: "channel",
  maxLength: API_SOURCE_MAXIMUMS.outputLength,
  sample: "18:42",
  external: true,
  picker: {
    de: { label: `API-Quelle: ${name}`, description: `Gibt den Beispielwert der API-Quelle ${name} aus. Beispiel: {api.${name}}`, sample: "18:42" },
    en: { label: `API source: ${name}`, description: `Outputs the example value from API source ${name}. Example: {api.${name}}`, sample: "18:42" },
  },
});

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
