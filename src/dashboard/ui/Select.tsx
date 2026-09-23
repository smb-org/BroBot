import { Select as MantineSelect } from "@mantine/core";

import { colors } from "./theme";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  /** Accessible name when the field carries no visible caption above it --
   *  e.g. the header's channel select, which sits in a 56px row with no
   *  room for one. Ignored once `label` is set. */
  ariaLabel?: string;
  hint?: string;
  error?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  title?: string;
}

/**
 * "Popover, Menu, Combobox: surface, strong border, radius sm,
 * shadow xs" (docs/input/DESIGN-neu.md, "Component defaults"). The dropdown
 * override lives here rather than in the global theme because `Select` is
 * the only place in this seam step that opens a Combobox.
 */
export function Select({
  label,
  ariaLabel,
  hint,
  error,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  busy = false,
  required = false,
  name,
  id,
  title,
}: SelectProps) {
  return (
    <MantineSelect
      label={label}
      aria-label={ariaLabel}
      description={hint}
      error={error ? `× ${error}` : undefined}
      value={value}
      onChange={onChange}
      data={options}
      placeholder={placeholder}
      disabled={disabled}
      aria-busy={busy}
      required={required}
      name={name}
      id={id}
      title={title}
      allowDeselect={false}
      comboboxProps={{ shadow: "xs" }}
      styles={{
        dropdown: { backgroundColor: colors.surface, borderColor: colors.hairlineStrong },
        option: { fontSize: "13px" },
      }}
    />
  );
}
