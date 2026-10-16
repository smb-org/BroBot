import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { VotekickSettings } from "../contracts";
import { votekickSettingsEditorCatalog } from "./locale";

const preview = (template: string, samples: Readonly<Record<string, string>>): string =>
  template.replace(/\{([^{}]+)\}/gu, (token, name: string) => samples[name] ?? token);

const spec: SettingsEditorSpec<VotekickSettings> = {
  sections: [
    { id: "starter", icon: "tabSettings", fields: [
      { kind: "roleThreshold", key: "starterMinRole", options: [
        { value: "viewer" }, { value: "subscriber" }, { value: "vip" }, { value: "moderator" }, { value: "broadcaster" },
      ] },
    ] },
    { id: "thresholds", icon: "tabSettings", note: "thresholdRule", fields: [
      { kind: "number", key: "minNetVotes", min: 3, max: 100_000, step: 1 },
      { kind: "number", key: "percent", min: 5, max: 100, step: 1, unit: "%" },
      { kind: "number", key: "windowSeconds", min: 30, max: 180, step: 1, unit: "s" },
      { kind: "timeoutDurationRange", key: "duration", min: 1, max: 3600 },
      { kind: "number", key: "channelCooldownSeconds", min: 60, max: 86400, step: 1, unit: "s" },
      { kind: "number", key: "targetCooldownSeconds", min: 60, max: 86400, step: 1, unit: "s" },
    ] },
    { id: "messages", icon: "tabMessages", fields: [
      { kind: "chatTarget", key: "chatTarget" },
      { kind: "switchCard", key: "startTextEnabled", children: [{ kind: "template", key: "startText", preview, optional: true, minRows: 2 }] },
      { kind: "switchCard", key: "passTextEnabled", children: [{ kind: "template", key: "passText", preview, optional: true, minRows: 2 }] },
      { kind: "switchCard", key: "failTextEnabled", children: [{ kind: "template", key: "failText", preview, optional: true, minRows: 2 }] },
      { kind: "switchCard", key: "expiredTextEnabled", children: [{ kind: "template", key: "expiredText", preview, optional: true, minRows: 2 }] },
      { kind: "switchCard", key: "protectedTextEnabled", children: [{ kind: "template", key: "protectedText", preview, optional: true, minRows: 2 }] },
      { kind: "switchCard", key: "busyTextEnabled", children: [{ kind: "template", key: "busyText", preview, optional: true, minRows: 2 }] },
    ] },
  ],
};

const definition: SettingsEditorDefinition<VotekickSettings> = {
  spec,
  layout: "columns",
  locales: { de: votekickSettingsEditorCatalog("de"), en: votekickSettingsEditorCatalog("en") },
};

export default definition;
