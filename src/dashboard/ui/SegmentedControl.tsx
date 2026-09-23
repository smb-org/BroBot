import { SegmentedControl as MantineSegmentedControl } from "@mantine/core";
import { useId, type KeyboardEvent } from "react";

import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

export interface SegmentedControlOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SegmentedControlOption[];
  size?: "form" | "compact";
  disabled?: boolean;
}

export function SegmentedControl({ label, hint, value, onChange, options, size = "form", disabled = false }: SegmentedControlProps) {
  const id = useId();
  const disabledReason = useDisabledFieldReason();
  const labelId = `segment-label-${id}`;
  const hintId = hint === undefined && disabledReason === null ? undefined : `segment-hint-${id}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || options.length < 2) return;
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
        : 0;
    if (delta === 0) return;
    const currentIndex = Math.max(0, options.findIndex((option) => option.value === value));
    const nextIndex = (currentIndex + delta + options.length) % options.length;
    const next = options[nextIndex];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next.value);
  };

  return (
    <div className={`ui-segmented-control ui-segmented-control--${size}`}>
      <span className="ui-segmented-control__label" id={labelId}>{label}</span>
      <MantineSegmentedControl
        className="ui-segmented-control__control"
        data={options.map(({ value: optionValue, label: optionLabel }) => ({ value: optionValue, label: optionLabel }))}
        value={value}
        onChange={onChange}
        fullWidth
        disabled={disabled}
        transitionDuration={0}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onKeyDown={handleKeyDown}
      />
      {hintId === undefined ? null : <span className="ui-segmented-control__hint" id={hintId}>{describedHelper(hint, disabledReason, `segment-${id}`)}</span>}
    </div>
  );
}
