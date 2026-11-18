import { useId, type ReactNode } from "react";

import { Switch as SwitchPrimitive } from "./primitives/switch";
import { LockedReason } from "./LockedReason";
import { useDisabledFieldReason } from "./DisabledFieldReason";

export interface SwitchRowProps {
  label: string;
  ariaLabel?: string;
  description?: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  invalid?: boolean;
  disabled?: boolean;
  pending?: boolean;
  lockedReason?: string;
  /** Optional value control rendered between the label and the switch, for one-line rules. */
  control?: ReactNode;
}

export function SwitchRow({ control, label, ariaLabel, description, hint, checked, onChange, invalid = false, disabled = false, pending = false, lockedReason }: SwitchRowProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const hintId = `${id}-hint`;
  const reasonId = `${id}-reason`;
  const blocked = disabled || pending || lockedReason !== undefined;
  // An explicit lockedReason wins; otherwise a disabled row points at the surrounding disabled-field reason.
  const contextReasonId = useDisabledFieldReason()?.id;
  const describedBy = [description === undefined ? null : descriptionId, hint === undefined ? null : hintId, lockedReason === undefined ? (disabled ? contextReasonId ?? null : null) : reasonId].filter((part): part is string => part !== null).join(" ") || undefined;

  return <div data-ui="" className="ui-switch-row" aria-busy={pending}>
    <span className="ui-switch-row__copy">
      <strong id={labelId}>{label}</strong>
      {description === undefined ? null : <small id={descriptionId}>{description}</small>}
    </span>
    {control === undefined ? null : <span className="ui-switch-row__control">{control}</span>}
    <SwitchPrimitive
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel === undefined ? labelId : undefined}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-busy={pending}
      checked={checked}
      disabled={blocked}
      onCheckedChange={(next, details) => {
        if (details.event.target instanceof Element && details.event.target.closest("fieldset:disabled") !== null) return;
        onChange(next);
      }}
    />
    {hint === undefined ? null : <span id={hintId} className="ui-switch-row__hint">{hint}</span>}
    <LockedReason id={reasonId} {...(lockedReason === undefined ? {} : { reason: lockedReason })} />
  </div>;
}
