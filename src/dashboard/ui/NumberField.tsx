import { NumberInput, type NumberInputHandlers } from "@mantine/core";
import { useRef } from "react";

import { Button } from "./Button";
import { colors } from "./theme";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

interface NumberFieldBaseProps {
  label: string;
  /** Accessible name override for a short visible `label` (e.g. "X" inside a
   *  "Shadow" section) that still needs a full name for assistive tech --
   *  `aria-label` on the input takes precedence over the associated
   *  `<label>` when computing the accessible name. */
  ariaLabel?: string;
  hint?: string;
  error?: string;
  unit?: string;
  value: number | "";
  onChange: (value: number | "") => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
}

export type NumberFieldProps = NumberFieldBaseProps & (
  | { step: number; increaseLabel: string; decreaseLabel: string }
  | { step?: undefined; increaseLabel?: never; decreaseLabel?: never }
);

/**
 * "Number fields carry their unit as a suffix in the field ('5 s', '50
 * viewers') and their range in the hint." (docs/input/DESIGN-neu.md,
 * "Inputs / Fields"). `unit` renders as a muted in-field suffix; the
 * min/max range belongs in `hint`, which the caller composes.
 */
export function NumberField({
  label,
  ariaLabel,
  hint,
  error,
  unit,
  value,
  onChange,
  min,
  max,
  disabled = false,
  required = false,
  name,
  id,
  step,
  increaseLabel,
  decreaseLabel,
}: NumberFieldProps) {
  const disabledReason = useDisabledFieldReason();
  const handlers = useRef<NumberInputHandlers>(null);
  const atMin = min !== undefined && typeof value === "number" && value <= min;
  const atMax = max !== undefined && typeof value === "number" && value >= max;

  const input = (
    <NumberInput
      label={label}
      aria-label={ariaLabel}
      description={hint === undefined && disabledReason === null ? undefined : <span className="ui-number-field__description">{describedHelper(hint, disabledReason, `number-${id ?? label}`)}</span>}
      error={error ? `× ${error}` : undefined}
      inputWrapperOrder={["label", "input", "description", "error"]}
      value={value}
      onChange={(next) => onChange(next === "" ? "" : Number(next))}
      disabled={disabled}
      required={required}
      name={name}
      id={id}
      role="spinbutton"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={typeof value === "number" ? value : undefined}
      {...(min !== undefined ? { min } : undefined)}
      {...(max !== undefined ? { max } : undefined)}
      {...(step === undefined ? {} : { step, hideControls: true, handlersRef: handlers })}
      rightSection={unit ? <span style={{ color: colors.text3, fontSize: "12px" }}>{unit}</span> : undefined}
      rightSectionWidth={unit ? Math.max(28, unit.length * 8 + 12) : undefined}
      rightSectionPointerEvents="none"
    />
  );

  return (
    step === undefined ? input : (
      <div className="ui-number-field">
        <div className="ui-number-field__stepper">
          <Button icon="minus" iconOnly ariaLabel={decreaseLabel} disabled={disabled || atMin} onClick={() => { handlers.current?.decrement(); }} />
          {input}
          <Button icon="plus" iconOnly ariaLabel={increaseLabel} disabled={disabled || atMax} onClick={() => { handlers.current?.increment(); }} />
        </div>
      </div>
    )
  );
}
