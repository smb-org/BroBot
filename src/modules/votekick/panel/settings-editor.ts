import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { VotekickSettings } from "../contracts";
import { votekickSettingsEditorCatalog } from "./locale";

const preview = (template: string, samples: Readonly<Record<string, string>>): string =>
  template.replace(/\{([^{}]+)\}/gu, (token, name: string) => samples[name] ?? token);

const spec: SettingsEditorSpec<VotekickSettings> = {
  sections: [
    { id: "thresholds", icon: "tabSettings", fields: [
      { kind: "number", key: "minNetVotes", min: 3, max: 100_000, step: 1 },
      { kind: "number", key: "percent", min: 5, max: 100, step: 1, unit: "%" },
      { kind: "number", key: "windowSeconds", min: 30, max: 180, step: 1, unit: "s" },
      { kind: "timeoutDurationRange", key: "duration", min: 1, max: 3600 },
      { kind: "number", key: "channelCooldownSeconds", min: 60, max: 86400, step: 1, unit: "s" },
      { kind: "number", key: "targetCooldownSeconds", min: 60, max: 86400, step: 1, unit: "s" },
    ] },
    { id: "messages", icon: "tabMessages", fields: [
      { kind: "chatTarget", key: "chatTarget" },
      { kind: "template", key: "startText", preview },
      { kind: "template", key: "passText", preview },
      { kind: "template", key: "failText", preview },
      { kind: "template", key: "expiredText", preview, optional: true },
      { kind: "template", key: "protectedText", preview },
      { kind: "template", key: "busyText", preview },
    ] },
  ],
};

const definition: SettingsEditorDefinition<VotekickSettings> = {
  spec,
  locales: { de: votekickSettingsEditorCatalog("de"), en: votekickSettingsEditorCatalog("en") },
};

export default definition;
