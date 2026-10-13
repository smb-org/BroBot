import { Button } from "./Button";

interface ChipGroupOption {
  value: string;
  label: string;
}

export interface ChipGroupProps {
  ariaLabel: string;
  value: string | null;
  onChange: (value: string | null) => void;
  selectedValues?: readonly string[];
  onSelectedValuesChange?: (values: readonly string[]) => void;
  options: readonly ChipGroupOption[];
  className?: string;
}

export function ChipGroup({ ariaLabel, value, onChange, selectedValues, onSelectedValuesChange, options, className }: ChipGroupProps) {
  const multiple = selectedValues !== undefined;
  return <div data-ui="" className={["ui-chip-group", className].filter(Boolean).join(" ")} role="group" aria-label={ariaLabel}>
    {options.map((option) => {
      const selected = multiple ? selectedValues.includes(option.value) : (value ?? "") === option.value;
      return <Button
        key={option.value.length === 0 ? "all" : option.value}
        size="compact"
        variant={selected ? "secondary" : "subtle"}
        ariaPressed={selected}
        className="ui-chip-group__option"
        onClick={() => {
          if (multiple) {
            const nextValues = selectedValues.filter((entry) => entry !== option.value);
            onSelectedValuesChange?.(selected ? nextValues : [...nextValues, option.value]);
          } else onChange(selected && option.value.length > 0 ? null : option.value.length === 0 ? null : option.value);
        }}
      >{option.label}</Button>;
    })}
  </div>;
}
