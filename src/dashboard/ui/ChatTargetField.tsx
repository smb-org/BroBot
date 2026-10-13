import { MessageCircle } from "lucide-react";
import { useId, useState, type ReactElement } from "react";

import type { ChatOutputTarget } from "../../contracts/values";
import { dashboardLanguage } from "../locale";
import { chatTargetFieldTexts } from "../chat-target-field-locale";
import { InspectorFieldRow } from "./InspectorParts";
import { FieldError } from "./FieldError";
import { PopoverContent, PopoverPrimitive } from "./primitives/popover";

type ChatTargetChoice = ChatOutputTarget | "channel_default";

const TARGETS: readonly ChatTargetChoice[] = ["all_chats", "source_only", "channel_default", "where_asked"];
const DEFAULT_ALLOWED: readonly ChatTargetChoice[] = ["all_chats", "source_only", "where_asked"];

export interface ChatTargetFieldProps {
  label: string;
  value: ChatOutputTarget | null;
  onChange: (value: ChatOutputTarget | null) => void;
  allowed?: readonly ChatTargetChoice[];
  disabled?: boolean;
  error?: string;
  reserveError?: boolean;
}

/** Shared portal-backed destination picker for messages sent to chat. */
export function ChatTargetField({ label, value, onChange, allowed = DEFAULT_ALLOWED, disabled = false, error, reserveError = false }: ChatTargetFieldProps): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);
  const texts = chatTargetFieldTexts[dashboardLanguage()];
  const hasError = error !== undefined && error.length > 0;
  const options = TARGETS.filter((target) => allowed.includes(target));
  const selectedValue = value ?? (allowed.includes("channel_default") ? "channel_default" : "source_only");
  const selected = options.find((target) => target === selectedValue) ?? options[0];
  const isSelected = (target: ChatTargetChoice): boolean => value === null
    ? allowed.includes("channel_default") ? target === "channel_default" : target === "source_only"
    : value === target;
  const labelFor = (target: ChatTargetChoice): string => target === "all_chats"
    ? texts.allChats
    : target === "source_only" ? texts.onlyOurChat : target === "where_asked" ? texts.automatic : texts.channelDefault;
  const descriptionFor = (target: ChatTargetChoice): string => target === "all_chats"
    ? texts.allChatsDescription
    : target === "source_only" ? texts.onlyOurChatDescription : target === "where_asked" ? texts.automaticDescription : texts.channelDefaultDescription;

  return (
    <InspectorFieldRow label={label} help={texts.sharedChatInfo}>
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
            <span className="ui-chat-target-field__value">{selected === undefined ? label : labelFor(selected)}</span>
            <span className="ui-chat-target-field__change">{texts.change}</span>
            <span className="ui-chat-target-field__chevron" aria-hidden="true">⌄</span>
          </PopoverPrimitive.Trigger>
          <PopoverContent role="dialog" aria-label={label} className="ui-chat-target-field__popover" initialFocus={false}>
            <div className="ui-chat-target-field__title">{label}</div>
            <div className="ui-chat-target-field__options" role="radiogroup" aria-label={label}>
              {options.map((target) => (
                <button
                  className={`ui-chat-target-field__option${isSelected(target) ? " is-selected" : ""}`}
                  key={target}
                  type="button"
                  role="radio"
                  aria-checked={isSelected(target)}
                  onClick={() => { onChange(target === "channel_default" ? null : target); setOpen(false); }}
                >
                  <span className="ui-chat-target-field__option-copy">
                    <strong>{labelFor(target)}</strong>
                    <small>{descriptionFor(target)}</small>
                  </span>
                  <span aria-hidden="true" className="ui-chat-target-field__radio" />
                </button>
              ))}
            </div>
          </PopoverContent>
          {reserveError || error !== undefined ? <FieldError id={`${id}-error`} className="ui-field__error" message={error} /> : null}
        </div>
      </PopoverPrimitive.Root>
    </InspectorFieldRow>
  );
}
