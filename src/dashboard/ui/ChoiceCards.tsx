import { useId } from "react";

import { Icon, type IconName } from "./Icon";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";
import { FieldError } from "./FieldError";

export interface ChoiceCardOption {
  value: string;
  label: string;
  description: string;
  icon?: IconName;
}

export interface ChoiceCardsProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ChoiceCardOption[];
  disabled?: boolean;
  error?: string;
  reserveError?: boolean;
}

export function ChoiceCards({ label, hint, value, onChange, options, disabled = false, error, reserveError = false }: ChoiceCardsProps) {
  const id = useId();
  const disabledReason = useDisabledFieldReason();
  const hasError = error !== undefined && error.length > 0;
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const reasonId = disabledReason === null ? undefined : `${disabledReason.id}-choice-${id}`;
  const describedBy = [hint === undefined ? null : hintId, reasonId, hasError ? errorId : undefined].filter((part): part is string => part !== null && part !== undefined).join(" ") || undefined;

  return <div data-ui="" className="ui-choice-cards-field">
    <span id={labelId} className="ui-choice-cards-field__label">{label}</span>
    <div data-ui="" className="ui-choice-cards" role="group" aria-labelledby={labelId} aria-describedby={describedBy} aria-invalid={hasError ? true : undefined}>
      {options.map((option) => {
        const selected = value === option.value;
        return <button
          key={option.value}
          type="button"
          tabIndex={0}
          className={`ui-choice-card${selected ? " is-selected" : ""}`}
          aria-label={`${option.label}. ${option.description}`}
          aria-pressed={selected}
          disabled={disabled}
          onClick={() => { onChange(option.value); }}
        >
          <span className="ui-choice-card__top">
            <span className="ui-choice-card__title">{option.icon === undefined ? null : <Icon name={option.icon} size={16} />}{option.label}</span>
            <span className="ui-choice-card__check" aria-hidden="true"><Icon name="copied" size={16} /></span>
          </span>
          <span className="ui-choice-card__description">{option.description}</span>
        </button>;
      })}
    </div>
    {hint === undefined ? <span className="ui-choice-cards-field__hint" aria-hidden="true">&nbsp;</span> : <span id={hintId} className="ui-choice-cards-field__hint">{hint}</span>}
    {describedHelper(null, disabledReason, `choice-${id}`)}
    {reserveError || error !== undefined ? <FieldError id={errorId} className="ui-field__error" message={error} /> : null}
  </div>;
}
