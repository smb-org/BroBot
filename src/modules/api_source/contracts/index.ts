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
  | "rate_limited";
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
    retryAfter?: number | null;
  };

export const apiSourceTemplateVariable = (name: string): TemplateVariable => ({
  name: `api.${name}`,
  group: "channel",
  maxLength: API_SOURCE_MAXIMUMS.outputLength,
  sample: "18:42",
  external: true,
  picker: {
    de: { label: `Datenquelle: ${name}`, description: `Gibt den Beispielwert der Datenquelle ${name} aus. Beispiel: {api.${name}}`, sample: "18:42" },
    en: { label: `Data source: ${name}`, description: `Outputs the example value from data source ${name}. Example: {api.${name}}`, sample: "18:42" },
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
    label: "Datenquellen",
    description: "Liest Werte von öffentlichen Webadressen für Chatbefehle aus.",
    variableGroup: "Datenquellen",
    unavailableText: "Der Wert kann gerade nicht geladen werden.",
    conditionLabel: (name) => `Datenquelle: ${name}`,
    trueValue: "Wahr",
    falseValue: "Falsch",
    mandatoryReason: "Datenquellen stellen Werte von öffentlichen Webadressen für Chatbefehle bereit.",
  },
  en: {
    label: "Data sources",
    description: "Reads values from public web addresses for chat commands.",
    variableGroup: "Data sources",
    unavailableText: "The value cannot be loaded right now.",
    conditionLabel: (name) => `Data source: ${name}`,
    trueValue: "True",
    falseValue: "False",
    mandatoryReason: "Data sources provide values from public web addresses to chat commands.",
  },
};
