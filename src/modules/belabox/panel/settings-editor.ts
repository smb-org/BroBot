import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { BelaboxSettings } from "../contracts";
import { belaboxSettingsEditorCatalog } from "./settings-locale";

const spec: SettingsEditorSpec<BelaboxSettings> = {
  sections: [{
    id: "polling",
    icon: "tabSettings",
    fields: [
      { kind: "segment", key: "mode", options: [{ value: "interval" }, { value: "on_demand" }] },
      { kind: "segment", key: "intervalSeconds", options: [
        { value: 5 }, { value: 15 }, { value: 30 }, { value: 60 },
      ] },
    ],
  }],
};

const definition: SettingsEditorDefinition<BelaboxSettings> = {
  spec,
  locales: { de: belaboxSettingsEditorCatalog("de"), en: belaboxSettingsEditorCatalog("en") },
};

export default definition;
