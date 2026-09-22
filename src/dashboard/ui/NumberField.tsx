import { NumberInput } from "@mantine/core";

import { colors } from "./theme";

export interface NumberFieldProps {
  label: string;
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

/**
 * "Number fields carry their unit as a suffix in the field ('5 s', '50
 * viewers') and their range in the hint." (docs/input/DESIGN-neu.md,
 * "Inputs / Fields"). `unit` renders as a muted in-field suffix; the
 * min/max range belongs in `hint`, which the caller composes.
 */
export function NumberField({
  label,
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
}: NumberFieldProps) {
  return (
    <NumberInput
      label={label}
      description={hint}
      error={error ? `× ${error}` : undefined}
      value={value}
      onChange={(next) => onChange(next === "" ? "" : Number(next))}
      disabled={disabled}
      required={required}
      name={name}
      id={id}
      {...(min !== undefined ? { min } : undefined)}
      {...(max !== undefined ? { max } : undefined)}
      rightSection={unit ? <span style={{ color: colors.text3, fontSize: "12px" }}>{unit}</span> : undefined}
      rightSectionWidth={unit ? Math.max(28, unit.length * 8 + 12) : undefined}
      rightSectionPointerEvents="none"
    />
  );
}
