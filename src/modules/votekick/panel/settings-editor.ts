import "./panel.css";

import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { VotekickSettings } from "../contracts";
import { votekickSettingsEditorCatalog } from "./locale";

const preview = (template: string, samples: Readonly<Record<string, string>>): string =>
  template.replace(/\{([^{}]+)\}/gu, (token, name: string) => samples[name] ?? token);

const spec: SettingsEditorSpec<VotekickSettings> = {
  sections: [
    { id: "settings", icon: "tabSettings", note: "thresholdRule", fields: [
      { kind: "roleThreshold", key: "starterMinRole", options: [
        { value: "viewer" }, { value: "subscriber" }, { value: "vip" }, { value: "moderator" }, { value: "broadcaster" },
      ] },
      { kind: "number", key: "minNetVotes", min: 3, max: 100_000, step: 1 },
      { kind: "number", key: "percent", min: 5, max: 100, step: 1, unit: "%" },
      { kind: "number", key: "windowSeconds", min: 30, max: 180, step: 1, unit: "s" },
      { kind: "timeoutDurationRange", key: "duration", min: 1, max: 3600, showLabels: true },
      { kind: "number", key: "channelCooldownSeconds", min: 60, max: 86400, step: 1, unit: "s" },
      { kind: "number", key: "targetCooldownSeconds", min: 60, max: 86400, step: 1, unit: "s" },
    ] },
    { id: "messages", icon: "tabMessages", fields: [
      { kind: "chatTarget", key: "chatTarget" },
      { kind: "message", key: "startText", enabledKey: "startTextEnabled", preview },
      { kind: "message", key: "passText", enabledKey: "passTextEnabled", preview },
      { kind: "message", key: "failText", enabledKey: "failTextEnabled", preview },
      { kind: "message", key: "expiredText", enabledKey: "expiredTextEnabled", preview },
      { kind: "message", key: "protectedText", enabledKey: "protectedTextEnabled", preview },
      { kind: "message", key: "busyText", enabledKey: "busyTextEnabled", preview },
    ] },
  ],
};

const definition: SettingsEditorDefinition<VotekickSettings> = {
  spec,
  layout: "columns",
  savePosition: "page-header",
  showTitle: false,
  className: "votekick-settings-editor",
  locales: { de: votekickSettingsEditorCatalog("de"), en: votekickSettingsEditorCatalog("en") },
};

export default definition;
