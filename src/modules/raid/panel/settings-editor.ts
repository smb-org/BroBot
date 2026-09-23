import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { RaidSettings } from "../contracts";
import { renderRaidText } from "../domain";
import { raidSettingsEditorCatalog } from "./locale";

const spec: SettingsEditorSpec<RaidSettings> = {
  sections: [
    { id: "messages", icon: "tabMessages", fields: [
      { kind: "number", key: "textThreshold", min: 0, max: 100000, step: 1 },
      { kind: "template", key: "textLong", preview: (template, values) => renderRaidText(template, values) },
      { kind: "template", key: "textShort", preview: (template, values) => renderRaidText(template, values) },
    ] },
    { id: "shoutout", icon: "shoutout", fields: [
      { kind: "switchCard", key: "shoutoutEnabled", children: [
        { kind: "number", key: "shoutoutThreshold", min: 0, max: 100000, step: 1 },
      ] },
    ] },
  ],
};

const definition: SettingsEditorDefinition<RaidSettings> = {
  spec,
  locales: { de: raidSettingsEditorCatalog("de"), en: raidSettingsEditorCatalog("en") },
};

export default definition;
