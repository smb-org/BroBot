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
  }, {
    id: "alerts",
    icon: "tabMessages",
    fields: [{ kind: "switchCard", key: "alertsEnabled", children: [
      { kind: "number", key: "lowBitrateKbps", min: 1, max: 1_000_000, step: 100 },
      { kind: "number", key: "recoverBitrateKbps", min: 1, max: 1_000_000, step: 100,
        validate: (value, settings) => value > settings.lowBitrateKbps },
      { kind: "number", key: "holdSeconds", min: 1, max: 86_400, step: 1,
        validate: (value, settings) => value >= settings.intervalSeconds },
      { kind: "number", key: "recoverHoldSeconds", min: 1, max: 86_400, step: 1,
        validate: (value, settings) => value >= settings.intervalSeconds },
      { kind: "switchCard", key: "chatEnabled", children: [
        { kind: "number", key: "chatCooldownSeconds", min: 0, max: 86_400, step: 1 },
        { kind: "template", key: "lowText", optional: true, minRows: 2,
          preview: (template) => template.replaceAll("{belabox.bitrate}", "3,200 kbps").replaceAll("{belabox.down_for}", "12 s") },
        { kind: "chatTarget", key: "lowTarget" },
        { kind: "template", key: "disconnectText", optional: true, minRows: 2,
          preview: (template) => template.replaceAll("{belabox.bitrate}", "3,200 kbps").replaceAll("{belabox.down_for}", "12 s") },
        { kind: "chatTarget", key: "disconnectTarget" },
        { kind: "template", key: "recoveryText", optional: true, minRows: 2,
          preview: (template) => template.replaceAll("{belabox.bitrate}", "3,200 kbps").replaceAll("{belabox.down_for}", "12 s") },
        { kind: "chatTarget", key: "recoveryTarget" },
      ] },
    ] }],
  }],
};

const definition: SettingsEditorDefinition<BelaboxSettings> = {
  spec,
  locales: { de: belaboxSettingsEditorCatalog("de"), en: belaboxSettingsEditorCatalog("en") },
};

export default definition;
