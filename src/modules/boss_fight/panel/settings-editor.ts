import type { BossFightSettings } from "../contracts";
import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import { bossFightSettingsEditorCatalog } from "./settings-editor-locale";

const spec: SettingsEditorSpec<BossFightSettings> = {
  sections: [
    { id: "rules", icon: "clock-hour-4", fields: [
      { kind: "number", key: "durationSeconds", min: 15, max: 300, step: 1, unit: "s" },
      { kind: "number", key: "attackCooldownSeconds", min: 1, max: 300, step: 1, unit: "s" },
      { kind: "number", key: "damageMinimum", min: 1, max: 1_000, step: 1 },
      { kind: "number", key: "damageMaximum", min: 1, max: 1_000, step: 1, validate: (value, settings) => value >= settings.damageMinimum },
    ] },
    { id: "reward", icon: "tabSettings", fields: [
      { kind: "number", key: "lootPool", min: 1, max: 100_000, step: 1 },
    ] },
    { id: "chat", icon: "tabMessages", fields: [
      { kind: "chatTarget", key: "chatTarget", allowed: ["all_chats", "source_only", "where_asked"] },
    ] },
    { id: "messages", icon: "tabMessages", fields: [
      { kind: "message", key: "startText", enabledKey: "startTextEnabled", preview: (template) => template },
      { kind: "message", key: "defeatedText", enabledKey: "defeatedTextEnabled", preview: (template) => template },
      { kind: "message", key: "timeoutText", enabledKey: "timeoutTextEnabled", preview: (template) => template },
    ] },
  ],
};

const definition: SettingsEditorDefinition<BossFightSettings> = {
  spec,
  locales: bossFightSettingsEditorCatalog,
  layout: "columns",
  pageColumns: [["rules", "chat"], ["reward"], ["messages"]],
  savePosition: "page-header",
  showTitle: false,
  className: "boss-fight-settings-editor",
  messageFields: [
    { messagePath: "startText", enabledPath: "startTextEnabled" },
    { messagePath: "defeatedText", enabledPath: "defeatedTextEnabled" },
    { messagePath: "timeoutText", enabledPath: "timeoutTextEnabled" },
  ],
};

export default definition;
