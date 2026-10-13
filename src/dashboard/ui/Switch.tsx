import { useId, type MouseEvent, type ReactNode } from "react";

import { Switch as SwitchPrimitive } from "./primitives/switch";
import { DisabledFieldReasonContext } from "./DisabledFieldReason";

export interface SwitchProps {
  id?: string;
  label?: string;
  ariaLabel?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
  lockedReason?: string;
  layout?: "stacked" | "inline" | "card";
  hint?: string;
  description?: string;
  error?: string;
  reserveError?: boolean;
  children?: ReactNode;
}

export function Switch({ id: suppliedId, label, ariaLabel, checked, onChange, disabled, pending, lockedReason, layout = "stacked", hint, description, error, reserveError = false, children }: SwitchProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const hasChildren = children !== undefined && children !== null;
  const reasonId = lockedReason === undefined ? undefined : `switch-reason-${id}`;
  const hintId = hint === undefined ? undefined : `switch-hint-${id}`;
  const descriptionId = description === undefined ? undefined : `switch-description-${id}`;
  const errorId = `switch-error-${id}`;
  const labelId = label === undefined ? undefined : `switch-label-${id}`;
  const isDisabled = disabled === true || pending === true || (layout !== "card" && lockedReason !== undefined);
  const hasError = error !== undefined && error.length > 0;
  const describedBy = [hintId, descriptionId, layout === "card" && checked ? undefined : reasonId, hasError ? errorId : undefined].filter((part): part is string => part !== undefined).join(" ") || undefined;
  const visual = <SwitchPrimitive
    id={id}
    className="switch__track"
    checked={checked}
    onCheckedChange={(next, details) => { if (details.event.target instanceof Element && details.event.target.matches(":disabled")) return; onChange(next); }}
    disabled={isDisabled}
    aria-label={label === undefined ? ariaLabel : undefined}
    aria-labelledby={labelId}
    aria-describedby={describedBy}
    aria-invalid={hasError ? true : undefined}
    aria-busy={pending}
    aria-disabled={isDisabled ? true : undefined}
    onClick={(event) => { event.stopPropagation(); }}
  />;
  const hintLine = hint === undefined ? null : <span id={hintId} className="ui-switch__hint">{hint}</span>;
  const reasonLine = lockedReason === undefined ? null : <span id={reasonId} className="switch-locked-reason" role="note">{lockedReason}</span>;
  const errorLine = reserveError || error !== undefined ? <span id={errorId} className="ui-field__error" aria-live="polite">{!hasError ? <span aria-hidden="true">&nbsp;</span> : <><span aria-hidden="true">× </span>{error}</>}</span> : null;

  if (layout === "inline") {
    return <div data-ui="" className="ui-switch-field" aria-busy={pending}>
      <div className="ui-switch-field__row">
        {visual}
        {label === undefined ? null : <label className="ui-switch-field__label" id={labelId} htmlFor={id}>{label}</label>}
      </div>
      {hintLine}{reasonLine}{errorLine}
    </div>;
  }

  if (layout === "card") {
    const toggleCard = (event: MouseEvent<HTMLDivElement>): void => {
      if (isDisabled || (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, label, [role='switch']"))) return;
      onChange(!checked);
    };
    return <>
      <div data-ui="" className={`ui-switch-card${checked ? " ui-switch-card--checked" : ""}`} aria-busy={pending} onClick={toggleCard}>
        <div className="ui-switch-card__heading">
          {label === undefined ? null : <span className="ui-switch-card__label">
            <span className="ui-switch-card__title" id={labelId}>{label}</span>
            {description === undefined ? null : <span className="ui-switch-card__description" id={descriptionId}>{description}</span>}
          </span>}
          {visual}
        </div>
        {!hasChildren ? null : <div className="ui-switch-card__children">
          <DisabledFieldReasonContext.Provider value={!checked && lockedReason !== undefined && reasonId !== undefined ? { id: reasonId, reason: lockedReason } : null}>
            <fieldset disabled={!checked || isDisabled} aria-describedby={checked ? undefined : reasonId}>{children}</fieldset>
          </DisabledFieldReasonContext.Provider>
        </div>}
        {hintLine}
      </div>
      {!hasChildren || !checked ? reasonLine : null}{errorLine}
    </>;
  }

  return <div data-ui="" className="ui-switch" aria-busy={pending}>
    {label === undefined ? null : <span className="ui-switch__label" id={labelId}>{label}</span>}
    <span className="ui-switch__control">{visual}</span>
    {hintLine}{reasonLine}{errorLine}
  </div>;
}
