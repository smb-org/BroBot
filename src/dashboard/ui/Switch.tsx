import { useId } from "react";
import type { MouseEvent, ReactNode } from "react";

import { DisabledFieldReasonContext } from "./DisabledFieldReason";

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
  layout?: "stacked" | "inline" | "card";
  hint?: string;
  description?: string;
  children?: ReactNode;
}

/** A single semantic switch control, with no separate checkbox indicator. */
export function Switch({ label, ariaLabel, checked, onChange, disabled, pending, lockedReason, layout = "stacked", hint, description, children }: SwitchProps) {
  const id = useId();
  const reasonId = lockedReason === undefined ? undefined : `switch-reason-${id}`;
  const hintId = hint === undefined ? undefined : `switch-hint-${id}`;
  const descriptionId = description === undefined ? undefined : `switch-description-${id}`;
  const labelId = label === undefined ? undefined : `switch-label-${id}`;
  const isDisabled = disabled === true || pending === true || (layout !== "card" && lockedReason !== undefined);
  const inputClassName = `ui-switch__input${layout === "inline" ? " ui-switch-field__input" : layout === "card" ? " ui-switch-card__input" : ""}`;
  const describedBy = [hintId, descriptionId, layout === "card" && checked ? undefined : reasonId].filter((part): part is string => part !== undefined).join(" ") || undefined;

  const input = (
    <input
      className={inputClassName}
      type="checkbox"
      role="switch"
      id={id}
      checked={checked}
      aria-checked={checked}
      aria-label={label === undefined ? ariaLabel : undefined}
      aria-labelledby={label === undefined ? undefined : labelId}
      aria-describedby={describedBy}
      aria-busy={pending}
      disabled={isDisabled}
      onChange={(event) => { onChange(event.currentTarget.checked); }}
    />
  );
  const visual = <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>;
  const hintLine = hint === undefined ? null : <span id={hintId} className="ui-switch__hint">{hint}</span>;
  const reasonLine = lockedReason === undefined ? null : <span id={reasonId} className="switch-locked-reason">{lockedReason}</span>;

  if (layout === "inline") {
    return (
      <div className="ui-switch-field" aria-busy={pending}>
        <div className="ui-switch-field__row">
          {input}
          <label className="ui-switch-field__label" htmlFor={id}>{label}{visual}</label>
        </div>
        {hintLine}
        {reasonLine}
      </div>
    );
  }

  if (layout === "card") {
    const toggleCard = (event: MouseEvent<HTMLDivElement>): void => {
      if (isDisabled || (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, label"))) return;
      onChange(!checked);
    };
    return (
      <div className={`ui-switch-card${checked ? " ui-switch-card--checked" : ""}`} aria-busy={pending} onClick={toggleCard}>
        <div className="ui-switch-card__heading">
          {input}
          <label className="ui-switch-card__label" htmlFor={id}>
            <span className="ui-switch-card__title">{label}</span>
            {description === undefined ? null : <span className="ui-switch-card__description" id={descriptionId}>{description}</span>}
          </label>
          {visual}
        </div>
        {children === undefined ? null : (
          <div className="ui-switch-card__children">
            {checked ? null : reasonLine}
            <DisabledFieldReasonContext.Provider value={!checked && lockedReason !== undefined && reasonId !== undefined ? { id: reasonId, reason: lockedReason } : null}>
              <fieldset disabled={!checked || isDisabled} aria-describedby={checked ? undefined : reasonId}>
                {children}
              </fieldset>
            </DisabledFieldReasonContext.Provider>
          </div>
        )}
        {hintLine}
        {children === undefined ? reasonLine : null}
      </div>
    );
  }

  return (
    <div className="ui-switch" aria-busy={pending}>
      {label === undefined ? null : <span className="ui-switch__label" id={labelId}>{label}</span>}
      <span className="ui-switch__control">{input}{visual}</span>
      {hintLine}
      {reasonLine}
    </div>
  );
}
