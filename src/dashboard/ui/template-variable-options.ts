import type { DashboardLanguage } from "../locale";
import type { TemplateVariable, TemplateContext } from "../../template";
import { effectiveTemplateVariables } from "../../template";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../template-variables";
import { channelVariableTemplateDescription, systemTemplateVariableLocale } from "../locale";
import type { TemplateVariableOption } from "./TextArea";

export interface PanelChannelVariable {
  name: string;
  value: number;
  description: string;
}

export const effectivePanelTemplateVariables = (
  context: TemplateContext,
  moduleVariables: readonly TemplateVariable[],
  channelVariables: readonly PanelChannelVariable[],
): TemplateVariable[] => effectiveTemplateVariables(
  context,
  moduleVariables,
  channelVariables.map((variable) => ({
    name: `var.${variable.name}`,
    group: "channel",
    sample: String(variable.value),
    maxLength: 10,
    source: "channel",
  })),
  SYSTEM_TEMPLATE_VARIABLE_LIST,
);

export const panelTemplateOptions = (
  context: TemplateContext,
  moduleVariables: readonly TemplateVariable[],
  channelVariables: readonly PanelChannelVariable[],
  language: DashboardLanguage,
  moduleDescriptions: readonly TemplateVariableOption[] = [],
): TemplateVariableOption[] => {
  const declarations = effectivePanelTemplateVariables(context, moduleVariables, channelVariables);
  const moduleByName = new Map(moduleDescriptions.map((variable) => [variable.name, variable]));
  const channelByName = new Map(channelVariables.map((variable) => [`var.${variable.name}`, variable]));
  return declarations.map((variable) => {
    if (variable.source === "system") {
      const localized = systemTemplateVariableLocale[language][variable.name as keyof typeof systemTemplateVariableLocale.de];
      return {
        name: variable.name,
        description: localized.description,
        sample: localized.sample,
        group: variable.group ?? "context",
        kind: "system",
        ...(variable.external === undefined ? {} : { external: variable.external }),
        ...(variable.parameters === "range" ? { parameter: { value: "1-100" } } : {}),
        ...(variable.parameters === "choices" ? { parameter: { value: "a|b|c" } } : {}),
      };
    }
    if (variable.source === "channel") {
      const channel = channelByName.get(variable.name);
      const localizedSample = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 }).format(Number(variable.sample));
      return {
        name: variable.name,
        description: channel?.description || channelVariableTemplateDescription[language],
        sample: localizedSample,
        group: "channel",
        kind: "channel",
      };
    }
    const localized = moduleByName.get(variable.name);
    return {
      name: variable.name,
      description: localized?.description ?? variable.name,
      sample: localized?.sample ?? variable.sample,
      group: variable.group ?? "context",
      kind: "module",
      ...(variable.external === undefined ? {} : { external: variable.external }),
      ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
    };
  });
};
