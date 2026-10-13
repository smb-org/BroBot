import { useId } from "react";

import { LockedReason } from "./LockedReason";
import { Select } from "./Select";

interface RoleThresholdOption {
  value: string;
  label: string;
  inclusion: string;
}

export interface RoleThresholdProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly RoleThresholdOption[];
  disabled?: boolean;
  lockedReason?: string;
  id?: string;
}

export function RoleThreshold({ label, value, onChange, options, disabled = false, lockedReason, id }: RoleThresholdProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const reasonId = `${controlId}-locked-reason`;
  const selected = options.find((option) => option.value === value) ?? options[0];

  return <div data-ui="" className="ui-role-threshold">
    <Select
      id={controlId}
      label={label}
      value={selected?.value ?? value}
      onChange={(next) => { if (next !== null) onChange(next); }}
      options={options.map(({ value: optionValue, label: optionLabel }) => ({ value: optionValue, label: optionLabel }))}
      hint={selected?.inclusion ?? ""}
      disabled={disabled || lockedReason !== undefined}
      {...(lockedReason === undefined ? {} : { describedBy: reasonId })}
    />
    <LockedReason id={reasonId} {...(lockedReason === undefined ? {} : { reason: lockedReason })} />
  </div>;
}
