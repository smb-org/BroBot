import { useId, useState, type KeyboardEvent } from "react";

import { useDisabledFieldReason } from "./DisabledFieldReason";
import { Input } from "./primitives/input";
import { FieldError } from "./FieldError";

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
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  clampOnBlur?: boolean;
  commitOnBlurOrEnter?: boolean;
  required?: boolean;
  name?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

const clampValue = (value: number, min: number | undefined, max: number | undefined): number => Math.max(min ?? Number.NEGATIVE_INFINITY, Math.min(max ?? Number.POSITIVE_INFINITY, value));

export function UnitInput({ id: suppliedId, label, ariaLabel, unit, value, onChange, min, max, step = 1, suggestions = [], hint, placeholder, error, disabled = false, clampOnBlur = true, commitOnBlurOrEnter = false, required = false, name, onKeyDown }: UnitInputProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const disabledReason = useDisabledFieldReason();
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [descriptionId, error === undefined ? null : errorId, disabledReason?.id].filter((part): part is string => part !== null && part !== undefined).join(" ");
  const updateInputValue = (next: number | ""): void => {
    if (commitOnBlurOrEnter) {
      setDraftValue(next === "" ? "" : String(next));
      return;
    }
    onChange(next);
  };

  const commitDraft = (): void => {
    if (draftValue === null) return;
    if (draftValue.length === 0) {
      setDraftValue(null);
      onChange("");
      return;
    }
    const parsed = Number(draftValue);
    if (!Number.isFinite(parsed)) {
      setDraftValue(null);
      return;
    }
    const committed = clampOnBlur ? clampValue(parsed, min, max) : parsed;
    setDraftValue(null);
    onChange(committed);
  };

  const onBlur = (): void => {
    if (commitOnBlurOrEnter) {
      commitDraft();
      return;
    }
    if (!clampOnBlur || typeof value !== "number") return;
    const clamped = clampValue(value, min, max);
    if (clamped !== value) onChange(clamped);
  };

  // Native step validation is anchored at min (min=1, step=100 rejects 1000), so the input
  // uses step="any" and the intended increment is applied to the arrow keys here.
  const onKeyDownWithStep = (event: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (commitOnBlurOrEnter && event.key === "Enter") {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const displayedValue = draftValue === null ? value : draftValue === "" ? "" : Number(draftValue);
    const base = typeof displayedValue === "number" ? displayedValue : 0;
    updateInputValue(clampValue(base + (event.key === "ArrowUp" ? step : -step), min, max));
  };

  return <div data-ui="" className="unit-input">
    <label className="ui-field__label" htmlFor={id}>{label}</label>
    <div className="unit-input__control">
      <Input id={id} type="number" inputMode="decimal" aria-label={ariaLabel} aria-describedby={describedBy} aria-invalid={error === undefined ? undefined : true} value={commitOnBlurOrEnter ? draftValue ?? value : value} min={min} max={max} step="any" placeholder={placeholder} disabled={disabled} required={required} name={name} onBlur={onBlur} onKeyDown={onKeyDownWithStep} onChange={(event) => {
        const next = event.currentTarget.value;
        updateInputValue(next.length === 0 ? "" : Number(next));
      }} className="unit-input__input" />
      {unit === undefined || unit.length === 0 ? null : <span className="unit-input__unit" aria-hidden="true">{unit}</span>}
    </div>
    {suggestions.length === 0 ? null : <div className="unit-input__suggestions" role="group" aria-label={label}>
      {suggestions.map((suggestion) => <button key={suggestion} type="button" disabled={disabled} className="unit-input__suggestion" aria-pressed={value === suggestion} onClick={() => { onChange(suggestion); }}>{suggestion}{unit === undefined ? "" : ` ${unit}`}</button>)}
    </div>}
    <span data-ui="" id={descriptionId} className="unit-input__description">{hint}</span>
    <FieldError id={errorId} className="unit-input__error" message={error} />
  </div>;
}
