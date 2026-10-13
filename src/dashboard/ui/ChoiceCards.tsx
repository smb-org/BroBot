import { Group, Radio, Stack } from "@mantine/core";
import { useId } from "react";

import { Icon, type IconName } from "./Icon";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

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
  const hintId = hint === undefined ? undefined : `choice-hint-${id}`;
  const errorId = `choice-error-${id}`;
  const hasError = error !== undefined && error.length > 0;
  const describedBy = [hintId, hasError ? errorId : undefined].filter((part): part is string => part !== undefined).join(" ") || undefined;

  return (
    <div className="ui-choice-cards__field">
      <Radio.Group
        data-ui=""
        className="ui-choice-cards"
        label={label}
        description={describedHelper(hint, disabledReason, `choice-${id}`)}
        inputWrapperOrder={["label", "input", "description"]}
        value={value}
        onChange={onChange}
        disabled={disabled}
        name={`choice-${id}`}
        aria-describedby={describedBy}
        aria-invalid={hasError ? true : undefined}
        descriptionProps={{ id: hintId }}
      >
        <Stack gap={8} className="ui-choice-cards__options">
          {options.map((option) => (
            <Radio.Card
              className="ui-choice-cards__option"
              key={option.value}
              value={option.value}
              aria-label={option.description.length === 0 ? option.label : `${option.label}. ${option.description}`}
              disabled={disabled}
              withBorder
            >
              <Group className="ui-choice-cards__content" wrap="nowrap" gap={12}>
                {option.icon === undefined ? null : <Icon name={option.icon} size={20} />}
                <span className="ui-choice-cards__copy">
                  <span className="ui-choice-cards__title">{option.label}</span>
                  <span className="ui-choice-cards__description">{option.description}</span>
                </span>
                <Radio.Indicator className="ui-choice-cards__indicator" aria-hidden="true" />
              </Group>
            </Radio.Card>
          ))}
        </Stack>
      </Radio.Group>
      {reserveError || error !== undefined ? <span id={errorId} className="ui-field__error" aria-live="polite">{!hasError ? <span aria-hidden="true">&nbsp;</span> : <><span aria-hidden="true">× </span>{error}</>}</span> : null}
    </div>
  );
}
