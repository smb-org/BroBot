import { TextInput } from "@mantine/core";
import type { KeyboardEvent } from "react";

import { Icon, type IconName } from "./Icon";

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
  icon?: IconName;
  className?: string;
  /** A caller that commits its own debounced draft on Enter (see the
   *  events person filter, #157) -- optional, nothing else needs it. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * A single-line text field. Project vocabulary only: `label`, `hint`,
 * `error` -- never Mantine's `description`/`error` render-prop shape.
 * "Inputs / Fields" in docs/input/DESIGN-neu.md: error carries a leading
 * `×` and the border stays strong (wired in the theme's `Input`
 * override, not here).
 */
export function Field({ label, hint, error, value, onChange, placeholder, disabled = false, required = false, name, id, icon, className, onKeyDown }: FieldProps) {
  return (
    <TextInput
      className={className}
      label={label}
      description={hint}
      error={error ? `× ${error}` : undefined}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      name={name}
      id={id}
      leftSection={icon === undefined ? undefined : <Icon name={icon} size={16} />}
      leftSectionPointerEvents="none"
    />
  );
}
