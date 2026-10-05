import type { SettingsEditorDefinition, SettingsEditorSpec } from "../../../dashboard/ui";
import type { ChatVotingSettings } from "../contracts";
import { isValidVoteLabelSetting } from "../domain";
import { chatVotingSettingsEditorCatalog } from "./locale";

const spec: SettingsEditorSpec<ChatVotingSettings> = {
  sections: [
    { id: "labels", icon: "tabSettings", fields: [
      { kind: "text", key: "yesNoLabels", maxLength: 70, optional: true, validate: (value) => isValidVoteLabelSetting(value, "yesNoLabels") },
      { kind: "text", key: "scaleLabels", maxLength: 175, optional: true, validate: (value) => isValidVoteLabelSetting(value, "scaleLabels") },
      { kind: "text", key: "optionLabels", maxLength: 315, optional: true, validate: (value) => isValidVoteLabelSetting(value, "optionLabels") },
      { kind: "number", key: "autoCloseSeconds", min: 0, max: 14_400, step: 30, unit: "s" },
    ] },
    { id: "result", icon: "tabMessages", fields: [
      { kind: "switchCard", key: "announceResult", children: [
        { kind: "template", key: "resultText", minRows: 2, preview: (template, values) =>
          template.replaceAll("{vote.result}", values["vote.result"] ?? "Yes: 8 (67%) · No: 4 (33%)") },
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
