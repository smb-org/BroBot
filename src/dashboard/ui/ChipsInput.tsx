import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "./Icon";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

export interface ChipsInputMessages {
  countLabel: (count: number, max: number) => ReactNode;
  atLimitHint: string;
  duplicateWarning: (entry: string) => string;
}

export interface ChipsInputProps {
  id?: string;
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  warning?: string;
  invalidValues?: readonly string[];
  stripPrefix?: string;
  normalize?: (entry: string) => string;
  validate?: (entry: string) => string | null;
  removeLabel: (entry: string) => string;
  disabled?: boolean;
  messages: ChipsInputMessages;
  listLabel: string;
  max?: number;
}

const normalizeEntry = (entry: string, stripPrefix: string | undefined, normalize: ((entry: string) => string) | undefined): string => {
  let next = normalize?.(entry) ?? entry;
  if (stripPrefix !== undefined && next.startsWith(stripPrefix)) next = next.slice(stripPrefix.length);
  return next;
};

export function ChipsInput({ id: suppliedId, label, values, onChange, placeholder, hint, error, warning, invalidValues = [], stripPrefix, normalize, validate, removeLabel, disabled = false, messages, listLabel, max }: ChipsInputProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const disabledReason = useDisabledFieldReason();
  const [draft, setDraft] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const atLimit = max !== undefined && values.length >= max;
  const effectiveError = error ?? validationError ?? undefined;
  const effectiveWarning = warning ?? duplicateWarning ?? undefined;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const warningId = `${id}-warning`;
  const prefixed = (entry: string): string => `${stripPrefix ?? ""}${entry}`;

  const add = (): void => {
    const nextValue = normalizeEntry(draft.trim(), stripPrefix, normalize);
    if (nextValue.length === 0) return;
    if (values.includes(nextValue)) {
      setDuplicateWarning(messages.duplicateWarning(prefixed(nextValue)));
      setValidationError(null);
      return;
    }
    if (max !== undefined && values.length >= max) return;
    const invalid = validate?.(nextValue) ?? null;
    if (invalid !== null) {
      setValidationError(invalid);
      return;
    }
    onChange([...values, nextValue]);
    setDraft("");
    setValidationError(null);
    setDuplicateWarning(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && draft.length === 0 && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const currentHint = atLimit ? messages.atLimitHint : hint;
  const describedBy = [descriptionId, effectiveError === undefined ? null : errorId, effectiveWarning === undefined ? null : warningId, disabledReason?.id].filter((part): part is string => part !== null && part !== undefined).join(" ");

  return <div data-ui="" className="chips-input" role="group" aria-label={listLabel}>
    <label className="ui-field__label" htmlFor={id}>{label}</label>
    <div className="chips-input__control" aria-describedby={describedBy}>
      {stripPrefix === undefined ? null : <span className="ui-field__prefix" aria-hidden="true">{stripPrefix}</span>}
      <div className="chips-input__tokens" aria-live="polite">
        {values.map((entry) => <span data-ui="" className={`chips-input__chip${invalidValues.includes(entry) ? " is-invalid" : ""}`} key={entry} aria-invalid={invalidValues.includes(entry) || undefined}>
          <span className="chips-input__chip-label">{entry}</span>
          <button className="chips-input__remove" id={`${id}-remove-${encodeURIComponent(entry)}`} type="button" aria-label={removeLabel(prefixed(entry))} disabled={disabled} onClick={() => { onChange(values.filter((value) => value !== entry)); }}><Icon name="close" size={16} /></button>
        </span>)}
      </div>
      <input data-ui="" id={id} className="chips-input__input" value={draft} placeholder={placeholder} disabled={disabled} readOnly={atLimit} aria-describedby={describedBy} onChange={(event) => { setDraft(event.currentTarget.value); setValidationError(null); setDuplicateWarning(null); }} onKeyDown={handleKeyDown} />
    </div>
    <span data-ui="" id={descriptionId} className="chips-input__description"><span>{currentHint ?? ""}</span>{max === undefined ? null : <span className="chips-input__count">{messages.countLabel(values.length, max)}</span>}{describedHelper(null, disabledReason, `chips-${id}`)}</span>
    <span data-ui="" id={errorId} className="ui-field__error" aria-live="polite">{effectiveError === undefined ? <span aria-hidden="true">&nbsp;</span> : <><span aria-hidden="true">× </span>{effectiveError}</>}</span>
    <span data-ui="" id={warningId} className="chips-input__warning" aria-hidden={effectiveWarning === undefined || undefined}><span>{effectiveWarning ?? ""}</span></span>
  </div>;
}
