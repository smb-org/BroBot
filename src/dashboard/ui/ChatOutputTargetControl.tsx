import { dashboardLanguage } from "../locale";
import type { ChatOutputTarget } from "../../contracts/values";
import { InspectorFieldRow } from "./InspectorParts";
import { Select } from "./Select";
import { chatOutputTargetTexts } from "../chat-output-target-locale";

export interface ChatOutputTargetControlProps {
  label: string;
  value: ChatOutputTarget | null;
  onChange: (value: ChatOutputTarget | null) => void;
  includeWhereAsked?: boolean;
  allowChannelDefault?: boolean;
  disabled?: boolean;
  /** Label above the select instead of beside it. */
  stacked?: boolean;
}

/** Compact, shared target control for all settings that produce chat output. */
export function ChatOutputTargetControl({
  label,
  value,
  onChange,
  includeWhereAsked = false,
  allowChannelDefault = false,
  disabled = false,
  stacked = false,
}: ChatOutputTargetControlProps) {
  const texts = chatOutputTargetTexts[dashboardLanguage()];
  const options = [
    { value: "all_chats", label: texts.allChats, description: texts.allChatsDescription },
    { value: "source_only", label: texts.onlyOurChat, description: texts.onlyOurChatDescription },
    ...(allowChannelDefault ? [{ value: "channel_default", label: texts.channelDefault }] : []),
    ...(includeWhereAsked
      ? [{ value: "where_asked", label: texts.automatic, description: texts.automaticDescription }]
      : []),
  ];
  return (
    <InspectorFieldRow label={label} help={texts.sharedChatInfo} {...(stacked ? { className: "inspector-field-row--stacked" } : {})}>
      <Select
        ariaLabel={label}
        value={value ?? (allowChannelDefault ? "channel_default" : "source_only")}
        onChange={(next) => {
          if (next === "channel_default") onChange(null);
          else if (next !== null) onChange(next as ChatOutputTarget);
        }}
        options={options}
        disabled={disabled}
      />
    </InspectorFieldRow>
  );
}
