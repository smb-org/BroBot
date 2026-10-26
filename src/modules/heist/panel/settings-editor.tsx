import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { HeistSettings } from "../contracts";
import { HEIST_TEMPLATE_VARIABLES } from "../contracts/template-variables";
import { heistSettingsEditorCatalog } from "./settings-editor-locale";

// The preview fills in the same samples the template catalogue declares, so the two cannot drift apart.
const templatePreview = (template: string, values: Readonly<Record<string, string>>): string =>
  Object.entries({
    ...Object.fromEntries(HEIST_TEMPLATE_VARIABLES.map(({ name, sample }) => [name, sample])),
    ...values,
  }).reduce((preview, [key, value]) => preview.replaceAll(`{${key}}`, value), template);

const spec: SettingsEditorSpec<HeistSettings> = {
  sections: [
    { id: "stakes", icon: "tabSettings", fields: [
      { kind: "number", key: "minStake", min: 1, max: 100_000, step: 1 },
      { kind: "number", key: "maxStake", min: 1, max: 100_000, step: 1 },
    ] },
    { id: "round", icon: "clock-hour-4", fields: [
      { kind: "number", key: "joinWindowSeconds", min: 15, max: 300, step: 1, unit: "s" },
      { kind: "number", key: "cooldownSeconds", min: 0, max: 3_600, step: 1, unit: "s" },
    ] },
    { id: "chance", icon: "tabSettings", fields: [
      { kind: "number", key: "baseChance", min: 0, max: 100, step: 1, unit: "%" },
      { kind: "number", key: "maxChance", min: 0, max: 100, step: 1, unit: "%" },
    ] },
    { id: "messages", icon: "tabMessages", fields: [
      { kind: "message", key: "startText", enabledKey: "startTextEnabled", preview: (template, values) => templatePreview(template, values) },
      { kind: "message", key: "confirmText", enabledKey: "confirmTextEnabled", preview: (template, values) => templatePreview(template, values) },
      { kind: "message", key: "resultText", enabledKey: "resultTextEnabled", preview: (template, values) => templatePreview(template, values) },
    ] },
  ],
};

const definition: SettingsEditorDefinition<HeistSettings> = {
  spec,
  locales: heistSettingsEditorCatalog,
  pageColumns: [["stakes", "round"], ["chance", "messages"]],
  layout: "columns",
  savePosition: "page-header",
  showTitle: false,
  className: "heist-settings-editor",
  messageFields: [
    { messagePath: "startText", enabledPath: "startTextEnabled" },
    { messagePath: "confirmText", enabledPath: "confirmTextEnabled" },
    { messagePath: "resultText", enabledPath: "resultTextEnabled" },
  ],
};

export default definition;
