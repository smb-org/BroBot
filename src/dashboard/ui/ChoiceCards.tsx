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
}

export function ChoiceCards({ label, hint, value, onChange, options, disabled = false }: ChoiceCardsProps) {
  const id = useId();
  const disabledReason = useDisabledFieldReason();
  const hintId = hint === undefined ? undefined : `choice-hint-${id}`;

  return (
    <Radio.Group
      className="ui-choice-cards"
      label={label}
      description={describedHelper(hint, disabledReason, `choice-${id}`)}
      inputWrapperOrder={["label", "input", "description", "error"]}
      value={value}
      onChange={onChange}
      disabled={disabled}
      name={`choice-${id}`}
      aria-describedby={hintId}
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
  );
}
