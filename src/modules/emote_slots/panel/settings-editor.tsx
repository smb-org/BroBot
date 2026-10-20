import type { ReactElement } from "react";

import type { SettingsEditorDefinition, SettingsEditorSpec, SettingsCustomFieldProps } from "../../../dashboard/ui";
import type { EmoteSlotSettings } from "../contracts";
import { emoteSlotSettingsEditorCatalog } from "./locale";
import { SlotReelTable, SlotShareField, SlotTextsField } from "./slot-fields";

const custom = (render: (props: SettingsCustomFieldProps<EmoteSlotSettings>) => ReactElement | null) => ({
  kind: "custom" as const,
  render,
});

const spec: SettingsEditorSpec<EmoteSlotSettings> = {
  sections: [
    { id: "reels", icon: "tabSettings", fields: [
      { ...custom((props) => <SlotReelTable {...props} />), key: "symbols" },
    ] },
    { id: "stakes", icon: "tabSettings", fields: [
      { kind: "number", key: "minStake", min: 1, max: 10_000, step: 1 },
      { kind: "number", key: "defaultStake", min: 1, max: 100_000, step: 1 },
      { kind: "number", key: "maxStake", min: 1, max: 100_000, step: 1 },
    ] },
    { id: "jackpot", icon: "tabPrewarning", fields: [
      { kind: "number", key: "jackpotSeed", min: 0, max: 1_000_000, step: 1 },
      { ...custom((props) => <SlotShareField {...props} />), key: "jackpotShareBp" },
      { kind: "switchCard", key: "announceJackpot" },
    ] },
    { id: "cooldown", icon: "clock-hour-4", fields: [
      { kind: "number", key: "cooldownSeconds", min: 0, max: 3_600, step: 1, unit: "s" },
    ] },
    { id: "chat", icon: "tabMessages", fields: [
      { kind: "chatTarget", key: "chatTarget", allowed: ["all_chats", "source_only", "where_asked"] },
    ] },
    { id: "texts", icon: "tabMessages", fields: [
      { ...custom((props) => <SlotTextsField {...props} />), key: "texts" },
    ] },
  ],
};

const definition: SettingsEditorDefinition<EmoteSlotSettings> = {
  spec,
  locales: emoteSlotSettingsEditorCatalog,
  layout: "columns",
  pageColumns: [["reels"], ["stakes", "jackpot", "cooldown"], ["chat", "texts"]],
  savePosition: "page-header",
  showTitle: false,
  className: "slot-settings-editor",
};

export default definition;
