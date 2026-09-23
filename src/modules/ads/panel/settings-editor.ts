import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { AdsSettings } from "../contracts";
import { renderAdBreakText, renderPrewarningText } from "../domain";
import { adsSettingsEditorCatalog } from "./locale";

const spec: SettingsEditorSpec<AdsSettings> = {
  sections: [
    { id: "announcements", icon: "tabSettings", fields: [
      { kind: "template", key: "automatic", preview: (template, values) => renderAdBreakText(template, Number(values.duration ?? "90")) },
      { kind: "template", key: "manual", preview: (template, values) => renderAdBreakText(template, Number(values.duration ?? "90")) },
    ] },
    { id: "prewarning", icon: "tabPrewarning", fields: [
      { kind: "switchCard", key: "prewarning", children: [
        { kind: "number", key: "leadSeconds", min: 30, max: 300, step: 10 },
      { kind: "template", key: "prewarningText", minRows: 2, preview: (template, values) => renderPrewarningText(template, values) },
      ] },
    ] },
  ],
};

const definition: SettingsEditorDefinition<AdsSettings> = {
  spec,
  locales: { de: adsSettingsEditorCatalog("de"), en: adsSettingsEditorCatalog("en") },
};

export default definition;
