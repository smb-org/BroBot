import "./panel.css";

import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { TempVipsSettings } from "../contracts";
import { tempVipsSettingsEditorCatalog } from "./settings-editor-locale";

const spec: SettingsEditorSpec<TempVipsSettings> = {
  sections: [
    { id: "settings", icon: "tabSettings", fields: [
      { kind: "number", key: "defaultDurationDays", min: 1, max: 90, step: 1 },
      { kind: "number", key: "maximumDurationDays", min: 1, max: 90, step: 1 },
    ] },
    { id: "messages", icon: "tabMessages", note: "ownershipCaveat", fields: [
      { kind: "switchCard", key: "announceExpiry" },
    ] },
  ],
};

const definition: SettingsEditorDefinition<TempVipsSettings> = {
  spec,
  layout: "columns",
  savePosition: "page-header",
  showTitle: false,
  className: "temp-vips-settings-editor",
  locales: { de: tempVipsSettingsEditorCatalog("de"), en: tempVipsSettingsEditorCatalog("en") },
};

export default definition;
