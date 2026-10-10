import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { ChatVotingSettings } from "../contracts";
import { chatVotingSettingsEditorCatalog } from "./locale";

const spec: SettingsEditorSpec<ChatVotingSettings> = {
  sections: [
    { id: "labels", icon: "tabSettings", fields: [
      { kind: "number", key: "autoCloseSeconds", min: 0, max: 14_400, step: 30, unit: "s" },
    ] },
    { id: "start", icon: "tabMessages", fields: [
      { kind: "template", key: "startText", optional: true, minRows: 2, preview: (template, values) =>
        template.replaceAll("{vote.title}", values["vote.title"] ?? "What should we eat today?")
          .replaceAll("{vote.options}", values["vote.options"] ?? "1 = Pizza, 2 = Burger, 3 = Kebab")
          .replaceAll("{vote.duration}", values["vote.duration"] ?? "2 minutes") },
    ] },
    { id: "result", icon: "tabMessages", fields: [
      { kind: "switchCard", key: "announceResult", children: [
        { kind: "template", key: "resultText", minRows: 2, preview: (template, values) =>
          template.replaceAll("{vote.result}", values["vote.result"] ?? "Yes: 8 (67%) · No: 4 (33%)")
            .replaceAll("{vote.title}", values["vote.title"] ?? "What should we eat today?")
            .replaceAll("{vote.options}", values["vote.options"] ?? "1 = Pizza, 2 = Burger, 3 = Kebab")
            .replaceAll("{vote.duration}", values["vote.duration"] ?? "2 minutes") },
        { kind: "chatTarget", key: "resultTarget" },
      ] },
    ] },
  ],
};

const definition: SettingsEditorDefinition<ChatVotingSettings> = {
  spec,
  locales: { de: chatVotingSettingsEditorCatalog("de"), en: chatVotingSettingsEditorCatalog("en") },
};

export default definition;
