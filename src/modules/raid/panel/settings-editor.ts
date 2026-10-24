import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { RaidSettings } from "../contracts";
import { renderRaidText } from "../domain";
import { raidSettingsEditorCatalog } from "./locale";

const spec: SettingsEditorSpec<RaidSettings> = {
  sections: [
    { id: "messages", icon: "tabMessages", fields: [
      { kind: "number", key: "textThreshold", min: 0, max: 100000, step: 1 },
      { kind: "message", key: "textLong", enabledKey: "textLongEnabled", targetKey: "textLongTarget", allowedTargets: ["all_chats", "source_only", "channel_default"], preview: (template, values) => template.trim().length === 0 ? "" : renderRaidText(template, values) },
    ] },
    { id: "shoutout", icon: "shoutout", fields: [
      { kind: "switchCard", key: "shoutoutEnabled", children: [
        { kind: "number", key: "shoutoutThreshold", min: 0, max: 100000, step: 1 },
      ] },
      { kind: "message", key: "textShort", enabledKey: "textShortEnabled", targetKey: "textShortTarget", allowedTargets: ["all_chats", "source_only", "channel_default"], preview: (template, values) => template.trim().length === 0 ? "" : renderRaidText(template, values) },
    ] },
  ],
};

const definition: SettingsEditorDefinition<RaidSettings> = {
  spec,
  locales: { de: raidSettingsEditorCatalog("de"), en: raidSettingsEditorCatalog("en") },
};

export default definition;
