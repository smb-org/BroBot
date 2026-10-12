import { useId, type KeyboardEvent } from "react";

import { useDisabledFieldReason } from "./DisabledFieldReason";
import { Input } from "./primitives/input";

export interface UnitInputProps {
  id?: string;
  label: string;
  ariaLabel?: string;
  unit?: string;
  value: number | "";
  onChange: (value: number | "") => void;
  min?: number;
  max?: number;
  step?: number;
  suggestions?: number[];
  hint?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

const clampValue = (value: number, min: number | undefined, max: number | undefined): number => Math.max(min ?? Number.NEGATIVE_INFINITY, Math.min(max ?? Number.POSITIVE_INFINITY, value));

export function UnitInput({ id: suppliedId, label, ariaLabel, unit, value, onChange, min, max, step = 1, suggestions = [], hint, error, disabled = false, required = false, name, onKeyDown }: UnitInputProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const disabledReason = useDisabledFieldReason();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [descriptionId, error === undefined ? null : errorId, disabledReason?.id].filter((part): part is string => part !== null && part !== undefined).join(" ");
  const onBlur = (): void => {
    if (typeof value !== "number") return;
    const clamped = clampValue(value, min, max);
    if (clamped !== value) onChange(clamped);
  };

  return <div data-ui="" className="unit-input">
    <label className="ui-field__label" htmlFor={id}>{label}</label>
    <div className="unit-input__control">
      <Input id={id} type="number" inputMode="decimal" aria-label={ariaLabel} aria-describedby={describedBy} aria-invalid={error === undefined ? undefined : true} value={value} min={min} max={max} step={step} disabled={disabled} required={required} name={name} onBlur={onBlur} onKeyDown={onKeyDown} onChange={(event) => {
        const next = event.currentTarget.value;
        onChange(next.length === 0 ? "" : Number(next));
      }} className="unit-input__input" />
      {unit === undefined || unit.length === 0 ? null : <span className="unit-input__unit" aria-hidden="true">{unit}</span>}
    </div>
    {suggestions.length === 0 ? null : <div className="unit-input__suggestions" role="group" aria-label={label}>
      {suggestions.map((suggestion) => <button key={suggestion} type="button" disabled={disabled} className="unit-input__suggestion" aria-pressed={value === suggestion} onClick={() => { onChange(suggestion); }}>{suggestion}{unit === undefined ? "" : ` ${unit}`}</button>)}
    </div>}
    <span data-ui="" id={descriptionId} className="unit-input__description">{hint}</span>
    <span data-ui="" id={errorId} className="unit-input__error" aria-live="polite">{error === undefined ? <span aria-hidden="true">&nbsp;</span> : <><span aria-hidden="true">× </span>{error}</>}</span>
  </div>;
}
