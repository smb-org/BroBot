import "./panel.css";

import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { AdsSettings } from "../contracts";
import { dashboardLanguage } from "../../../dashboard/locale";
import { renderAdBreakText, renderPrewarningText } from "../domain";
import { adsSettingsEditorCatalog } from "./locale";

const spec: SettingsEditorSpec<AdsSettings> = {
  sections: [
    { id: "announcements", icon: "tabSettings", fields: [
      { kind: "message", key: "automatic", targetKey: "automaticTarget", preview: (template, values) => template.trim().length === 0 ? "" : renderAdBreakText(template, Number(values["ads.duration"] ?? "90"), dashboardLanguage()) },
      { kind: "message", key: "manual", targetKey: "manualTarget", preview: (template, values) => template.trim().length === 0 ? "" : renderAdBreakText(template, Number(values["ads.duration"] ?? "90"), dashboardLanguage()) },
    ] },
    { id: "prewarning", icon: "tabPrewarning", fields: [
      { kind: "number", key: "leadSeconds", min: 30, max: 300, step: 10 },
      { kind: "message", key: "prewarningText", targetKey: "prewarningTarget", preview: (template, values) => renderPrewarningText(template, { "ads.seconds": values["ads.seconds"] ?? "60" }) },
    ] },
  ],
};

const definition: SettingsEditorDefinition<AdsSettings> = {
  spec,
  locales: { de: adsSettingsEditorCatalog("de"), en: adsSettingsEditorCatalog("en") },
};

export default definition;
