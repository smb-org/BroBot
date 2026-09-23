import { Chip as MantineChip, Group as MantineGroup } from "@mantine/core";

export interface ChipGroupOption {
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

/**
 * A row of toggle chips for filters with a small fixed set of values.
 * Single-select callers include an "all" choice first; multiple-select
 * callers pass selected values and can represent several active filters.
 * Colors and radius come from the shared theme (`ui/theme.ts`), the same
 * as everywhere else Mantine renders in this seam.
 */
export function ChipGroup({ ariaLabel, value, onChange, selectedValues, onSelectedValuesChange, options, className }: ChipGroupProps) {
  const children = options.map((option) => (
    <MantineChip key={option.value.length === 0 ? "all" : option.value} value={option.value} variant="outline">
      {option.label}
    </MantineChip>
  ));

  if (selectedValues !== undefined) {
    return (
      <MantineChip.Group
        multiple
        value={[...selectedValues]}
        onChange={(next) => { onSelectedValuesChange?.(next); }}
      >
        <MantineGroup className={className} gap="xs" wrap="nowrap" role="group" aria-label={ariaLabel}>
          {children}
        </MantineGroup>
      </MantineChip.Group>
    );
  }

  return (
    <MantineChip.Group
      value={value ?? ""}
      onChange={(next) => { onChange(typeof next === "string" && next.length > 0 ? next : null); }}
    >
      <MantineGroup className={className} gap="xs" wrap="nowrap" role="group" aria-label={ariaLabel}>
        {children}
      </MantineGroup>
    </MantineChip.Group>
  );
}
