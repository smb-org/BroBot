import type { TemplateVariable } from "../../contract";
import type { ModuleLanguage } from "../../contract";

export const CURRENCY_TEMPLATE_VARIABLE = {
  name: "currency.convert",
  group: "channel",
  maxLength: 32,
  sample: "11,50 €",
  parameters: "currency_pair",
  parameterDefault: "USD EUR",
  external: true,
  picker: {
    de: { label: "Währungsumrechnung", description: "Wandelt den ersten Betrag des Befehls in die Zielwährung um. Beispiel: {currency.convert USD EUR}" },
    en: { label: "Currency conversion", description: "Converts the first amount in the command to the target currency. Example: {currency.convert USD EUR}" },
  },
} as const satisfies TemplateVariable;

export const currencyModuleCatalog: Readonly<Record<ModuleLanguage, {
  variableGroup: string;
  unavailableText: string;
  mandatoryReason: string;
  usageText: (commandName: string) => string;
}>> = {
  de: {
    variableGroup: "Währung",
    unavailableText: "Wechselkursdaten sind derzeit nicht verfügbar.",
    mandatoryReason: "Die Währungsdatenquelle stellt den Umrechnungswert für Textbefehle bereit.",
    usageText: (commandName) => `Nutzung: !${commandName} 12,50`,
  },
  en: {
    variableGroup: "Currency",
    unavailableText: "Exchange rate data is currently unavailable.",
    mandatoryReason: "The currency data source provides conversion values for text commands.",
    usageText: (commandName) => `Usage: !${commandName} 12.50`,
  },
};
