import { useId } from "react";

export interface SwitchProps {
  label?: string;
  /** Accessible name when the switch carries no visible `label`. */
  ariaLabel?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** A switch is an immediate action, never behind a SaveBar. */
  pending?: boolean;
  /** Locks the control and shows the reason beside it. */
  lockedReason?: string;
}

/** A single semantic switch control, with no separate checkbox indicator. */
export function Switch({ label, ariaLabel, checked, onChange, disabled, pending, lockedReason }: SwitchProps) {
  const id = useId();
  const reasonId = lockedReason === undefined ? undefined : `switch-reason-${id}`;
  const labelId = label === undefined ? undefined : `switch-label-${id}`;
  const isDisabled = disabled === true || lockedReason !== undefined || pending === true;

  return (
    <div className="ui-switch" aria-busy={pending}>
      {label === undefined ? null : <span className="ui-switch__label" id={labelId}>{label}</span>}
      <button
        className="switch"
        type="button"
        role="switch"
        aria-label={label === undefined ? ariaLabel : undefined}
        aria-labelledby={labelId}
        aria-checked={checked}
        aria-busy={pending}
        aria-describedby={reasonId}
        disabled={isDisabled}
        onClick={() => { onChange(!checked); }}
      >
        <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
      </button>
      {lockedReason === undefined ? null : <span id={reasonId} className="switch-locked-reason">{lockedReason}</span>}
    </div>
  );
}
