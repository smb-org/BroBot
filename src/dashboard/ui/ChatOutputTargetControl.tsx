import { dashboardLanguage } from "../locale";
import type { ChatOutputTarget } from "../../contracts/values";
import { InspectorFieldRow } from "./InspectorParts";
import { Select } from "./Select";
import { chatOutputTargetTexts } from "../chat-output-target-locale";

export interface ChatOutputTargetControlProps {
  label: string;
  value: ChatOutputTarget;
  onChange: (value: ChatOutputTarget) => void;
  includeWhereAsked?: boolean;
  disabled?: boolean;
}

/** Compact, shared target control for all settings that produce chat output. */
export function ChatOutputTargetControl({
  label,
  value,
  onChange,
  includeWhereAsked = false,
  disabled = false,
}: ChatOutputTargetControlProps) {
  const texts = chatOutputTargetTexts[dashboardLanguage()];
  const options = [
    { value: "all_chats", label: texts.allChats, description: texts.allChatsDescription },
    { value: "source_only", label: texts.onlyOurChat, description: texts.onlyOurChatDescription },
    ...(includeWhereAsked
      ? [{ value: "where_asked", label: texts.automatic, description: texts.automaticDescription }]
      : []),
  ];
  return (
    <InspectorFieldRow label={label} help={texts.sharedChatInfo}>
      <Select
        ariaLabel={label}
        value={value}
        onChange={(next) => { if (next !== null) onChange(next as ChatOutputTarget); }}
        options={options}
        disabled={disabled}
      />
    </InspectorFieldRow>
  );
}
