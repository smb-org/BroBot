import { Select as MantineSelect } from "@mantine/core";
import type { ComboboxItem, ComboboxLikeRenderOptionInput } from "@mantine/core";
import type { ReactNode } from "react";

import { useDisabledFieldReason } from "./DisabledFieldReason";
import { TextReveal } from "./TextReveal";
import { colors } from "./theme";

export interface SelectOption {
  value: string;
  label: string;
  /** One-line explanation rendered under the label in the dropdown. */
  description?: string;
}

/** Renders `label` alone, or `label` + a one-line `description` underneath
 *  when the option carries one (see `ChoiceCards` for the same shape). */
const renderOption = ({ option }: ComboboxLikeRenderOptionInput<ComboboxItem>): ReactNode => {
  const description = (option as SelectOption).description;
  if (description === undefined) return <span>{option.label}</span>;
  return (
    <span className="ui-select__option">
      <span className="ui-select__option-label">{option.label}</span>
      <span className="ui-select__option-description">{description}</span>
    </span>
  );
};

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
  /** Omits reserved hint/error rows for controls inside fixed-height chrome. */
  compact?: boolean;
  busy?: boolean;
  searchable?: boolean;
  /** Controlled search text; pairs with `onSearchChange` for callers that
   *  need to inspect what the user typed (e.g. to offer a custom entry). */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  required?: boolean;
  name?: string;
  id?: string;
  title?: string;
  describedBy?: string;
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
  compact = false,
  busy = false,
  searchable = false,
  searchValue,
  onSearchChange,
  required = false,
  name,
  id,
  title,
  describedBy,
}: SelectProps) {
  const disabledReason = useDisabledFieldReason();
  const contextualDescriptionId = describedBy !== undefined && disabledReason !== null && id !== undefined
    ? `${describedBy}-select-${id}`
    : undefined;
  const description: ReactNode = (
    <span className="ui-select__description">
      {hint === undefined ? null : <TextReveal text={hint} />}
      {contextualDescriptionId === undefined || disabledReason === null ? null : <span className="sr-only">{disabledReason.reason}</span>}
    </span>
  );
  return (
    <MantineSelect
      className={`ui-select${compact ? " ui-select--compact" : ""}`}
      label={label}
      aria-label={ariaLabel}
      description={compact ? undefined : description}
      {...(contextualDescriptionId === undefined ? {} : {
        descriptionProps: {
          id: contextualDescriptionId,
        },
      })}
      inputWrapperOrder={compact ? ["input"] : ["label", "input", "description", "error"]}
      error={compact || !error ? undefined : <span><span aria-hidden="true">× </span><TextReveal text={error} /></span>}
      value={value}
      onChange={onChange}
      data={options}
      placeholder={placeholder}
      disabled={disabled}
      searchable={searchable}
      {...(searchValue === undefined ? {} : { searchValue })}
      {...(onSearchChange === undefined ? {} : { onSearchChange })}
      aria-busy={busy}
      required={required}
      name={name}
      id={id}
      title={title}
      aria-describedby={describedBy}
      allowDeselect={false}
      comboboxProps={{ shadow: "xs", width: "max-content" }}
      renderOption={renderOption}
      styles={{
        dropdown: { backgroundColor: colors.surface, borderColor: colors.hairlineStrong, maxWidth: "min(90vw, 320px)" },
        option: { fontSize: "13px" },
      }}
    />
  );
}
