import { Select as MantineSelect } from "@mantine/core";

import { colors } from "./theme";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  hint?: string;
  error?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
}

/**
 * "Popover, Menu, Combobox: Fläche Taste, Rand Linie-Stark, Radius sm,
 * Schatten xs" (docs/input/DESIGN-neu.md, "Bauteilvorgaben"). The dropdown
 * override lives here rather than in the global theme because `Select` is
 * the only place in this seam step that opens a Combobox.
 */
export function Select({
  label,
  hint,
  error,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  required = false,
  name,
  id,
}: SelectProps) {
  return (
    <MantineSelect
      label={label}
      description={hint}
      error={error ? `× ${error}` : undefined}
      value={value}
      onChange={onChange}
      data={options}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      name={name}
      id={id}
      allowDeselect={false}
      comboboxProps={{ shadow: "xs" }}
      styles={{
        dropdown: { backgroundColor: colors.surface, borderColor: colors.hairlineStrong },
        option: { fontSize: "13px" },
      }}
    />
  );
}
