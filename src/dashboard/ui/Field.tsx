import { TextInput } from "@mantine/core";

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
}

/**
 * A single-line text field. Project vocabulary only: `label`, `hint`,
 * `error` -- never Mantine's `description`/`error` render-prop shape.
 * "Inputs / Fields" in docs/input/DESIGN-neu.md: error carries a leading
 * `×` and the border stays "Linie-Stark" (wired in the theme's `Input`
 * override, not here).
 */
export function Field({ label, hint, error, value, onChange, placeholder, disabled = false, required = false, name, id }: FieldProps) {
  return (
    <TextInput
      label={label}
      description={hint}
      error={error ? `× ${error}` : undefined}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      name={name}
      id={id}
    />
  );
}
