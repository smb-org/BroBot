import { Chip as MantineChip, Group as MantineGroup } from "@mantine/core";

export interface ChipGroupOption {
  value: string;
  label: string;
}

export interface ChipGroupProps {
  ariaLabel: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: readonly ChipGroupOption[];
}

/**
 * A single-select row of toggle chips, for a filter with a small fixed set
 * of values plus "no filter". Mantine's `Chip.Group` always keeps one chip
 * selected in single-select mode, so the caller's first option should be
 * the "all" choice; picking it reports `null`, everything else its own
 * `value`. Colors and radius come from the shared theme (`ui/theme.ts`),
 * the same as everywhere else Mantine renders in this seam.
 */
export function ChipGroup({ ariaLabel, value, onChange, options }: ChipGroupProps) {
  return (
    <MantineChip.Group
      value={value ?? ""}
      onChange={(next) => { onChange(typeof next === "string" && next.length > 0 ? next : null); }}
    >
      <MantineGroup gap="xs" role="group" aria-label={ariaLabel}>
        {options.map((option) => (
          <MantineChip key={option.value.length === 0 ? "all" : option.value} value={option.value} variant="outline">
            {option.label}
          </MantineChip>
        ))}
      </MantineGroup>
    </MantineChip.Group>
  );
}
