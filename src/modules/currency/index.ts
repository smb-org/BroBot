import { z } from "zod";

import type { BotModule, ModuleTemplateValueContext } from "../contract";
import { CURRENCY_TEMPLATE_VARIABLE, currencyModuleCatalog } from "./contracts";
import { exchangeRate } from "./adapters/rates";

const settingsSchema = z.object({});
const unavailableText = {
  de: currencyModuleCatalog.de.unavailableText,
  en: currencyModuleCatalog.en.unavailableText,
} as const;
const amountPattern = /^(?:0|[1-9]\d{0,11})(?:[.,]\d{1,6})?$/u;

export const parseCurrencyAmount = (input: string): number | null => {
  const firstArgument = input.trim().split(/\s+/u)[0] ?? "";
  if (firstArgument.length === 0 || firstArgument.length > 20 || !amountPattern.test(firstArgument)) return null;
  const amount = Number(firstArgument.replace(",", "."));
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000_000 ? amount : null;
};

const convert = async (parameter: string, context: ModuleTemplateValueContext): Promise<string> => {
  const match = /^([A-Za-z]{3}) ([A-Za-z]{3})$/u.exec(parameter);
  if (match === null) return unavailableText[(await context.channelLanguage())];
  const base = match[1]?.toUpperCase();
  const target = match[2]?.toUpperCase();
  if (base === undefined || target === undefined) return unavailableText[(await context.channelLanguage())];
  const language = await context.channelLanguage();
  const commandInput = context.commandInput;
  const amount = parseCurrencyAmount(commandInput?.arguments ?? "");
  if (amount === null) {
    if (commandInput?.usageText !== undefined && commandInput.usageText.trim().length > 0) return commandInput.usageText.trim();
    return currencyModuleCatalog[language].usageText(commandInput?.commandName ?? "convert");
  }
  try {
    const rate = base === target ? 1 : await exchangeRate(context.DB, base, target, context.now);
    return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", {
      style: "currency",
      currency: target,
      maximumFractionDigits: 2,
    }).format(amount * rate);
  } catch {
    return unavailableText[language];
  }
};

export const currencyModule: BotModule<typeof settingsSchema> = {
  id: "currency",
  panelIcon: { paths: ["M12 3v18", "M17 7H9a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H7"] },
  templateContext: "chat_command",
  templateVariableGroup: {
    label: { de: currencyModuleCatalog.de.variableGroup, en: currencyModuleCatalog.en.variableGroup },
    icon: { paths: ["M12 3v18", "M17 7H9a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H7"] },
    order: 30,
  },
  templateVariableCatalog: [{ ...CURRENCY_TEMPLATE_VARIABLE, contexts: ["chat_command"] }],
  mandatory: true,
  mandatoryReason: {
    de: currencyModuleCatalog.de.mandatoryReason,
    en: currencyModuleCatalog.en.mandatoryReason,
  },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateUnavailableText: unavailableText,
  resolveTemplateParameter: (name, parameter, context) => name === "currency.convert"
    ? convert(parameter, context)
    : Promise.resolve(null),
};

export { exchangeRate } from "./adapters/rates";
