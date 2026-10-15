import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { MessageCircle } from "lucide-react";
import { useId, useState, type ReactElement } from "react";

import type { ChatOutputTarget } from "../../contracts/values";
import { dashboardLanguage, type DashboardLanguage } from "../locale";
import { chatTargetFieldTexts } from "../chat-target-field-locale";
import { InspectorFieldRow } from "./InspectorParts";
import { FieldError } from "./FieldError";
import { PopoverContent, PopoverPrimitive } from "./primitives/popover";

type ChatTargetChoice = ChatOutputTarget | "channel_default";

const TARGETS: readonly ChatTargetChoice[] = ["all_chats", "source_only", "channel_default", "where_asked"];
const DEFAULT_ALLOWED: readonly ChatTargetChoice[] = ["all_chats", "source_only", "where_asked"];

export interface ChatTargetFieldProps {
  label: string;
  language?: DashboardLanguage;
  value: ChatOutputTarget | null;
  onChange: (value: ChatOutputTarget | null) => void;
  allowed?: readonly ChatTargetChoice[];
  effectiveDefault?: ChatOutputTarget;
  disabled?: boolean;
  error?: string;
  reserveError?: boolean;
  /** Label left of the trigger; only for rows aligned with a sibling action. */
  inline?: boolean;
}

/** Shared portal-backed destination picker for messages sent to chat. */
export function ChatTargetField({ label, language, value, onChange, allowed = DEFAULT_ALLOWED, effectiveDefault, disabled = false, error, reserveError = false, inline = false }: ChatTargetFieldProps): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);
  const texts = chatTargetFieldTexts[language ?? dashboardLanguage()];
  const hasError = error !== undefined && error.length > 0;
  const options = TARGETS.filter((target) => allowed.includes(target));
  const selectedValue = value ?? (allowed.includes("channel_default") ? "channel_default" : "source_only");
  const selected = options.find((target) => target === selectedValue) ?? options[0];
  const inheritedOutsideChoices = value === null && !allowed.includes("channel_default");
  const isSelected = (target: ChatTargetChoice): boolean => value === null
    ? allowed.includes("channel_default") ? target === "channel_default" : false
    : value === target;
  const concreteLabelFor = (target: ChatOutputTarget): string => target === "all_chats"
    ? texts.allChats
    : target === "source_only" ? texts.onlyOurChat : texts.automatic;
  const labelFor = (target: ChatTargetChoice): string => target === "channel_default"
    ? texts.channelDefault(effectiveDefault === undefined ? undefined : concreteLabelFor(effectiveDefault))
    : concreteLabelFor(target);
  const descriptionFor = (target: ChatTargetChoice): string => target === "channel_default"
    ? texts.channelDefaultDescription(effectiveDefault === undefined ? undefined : concreteLabelFor(effectiveDefault))
    : target === "all_chats"
    ? texts.allChatsDescription
    : target === "source_only" ? texts.onlyOurChatDescription : texts.automaticDescription;

  return (
    <InspectorFieldRow label={label} help={texts.sharedChatInfo} {...(inline ? {} : { className: "inspector-field-row--stacked" })}>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <div data-ui="" className="ui-chat-target-field">
          <PopoverPrimitive.Trigger
            type="button"
            className="ui-chat-target-field__trigger"
            disabled={disabled || selected === undefined}
            aria-label={label}
            aria-haspopup="dialog"
            aria-describedby={hasError ? `${id}-error` : undefined}
            aria-invalid={hasError ? true : undefined}
          >
            <MessageCircle aria-hidden="true" size={15} />
            <span className="ui-chat-target-field__value">{inheritedOutsideChoices
              ? texts.channelDefault(effectiveDefault === undefined ? undefined : concreteLabelFor(effectiveDefault))
              : selected === undefined ? label : labelFor(selected)}</span>
            <span className="ui-chat-target-field__chevron" aria-hidden="true">⌄</span>
          </PopoverPrimitive.Trigger>
          <PopoverContent role="dialog" aria-label={label} className="ui-chat-target-field__popover" initialFocus={false}>
            <div className="ui-chat-target-field__title">{label}</div>
            <RadioGroup
              className="ui-chat-target-field__options"
              aria-label={label}
              value={inheritedOutsideChoices ? "channel_default" : selected}
              onValueChange={(target: ChatTargetChoice) => {
                onChange(target === "channel_default" ? null : target);
                setOpen(false);
              }}
            >
              {options.map((target) => (
                <Radio.Root
                  className={`ui-chat-target-field__option${isSelected(target) ? " is-selected" : ""}`}
                  key={target}
                  value={target}
                >
                  <span className="ui-chat-target-field__option-copy">
                    <strong>{labelFor(target)}</strong>
                    <small>{descriptionFor(target)}</small>
                  </span>
                  <span aria-hidden="true" className="ui-chat-target-field__radio"><Radio.Indicator className="ui-chat-target-field__radio-indicator" /></span>
                </Radio.Root>
              ))}
            </RadioGroup>
          </PopoverContent>
          {reserveError || error !== undefined ? <FieldError id={`${id}-error`} className="ui-field__error" message={error} /> : null}
        </div>
      </PopoverPrimitive.Root>
    </InspectorFieldRow>
  );
}
