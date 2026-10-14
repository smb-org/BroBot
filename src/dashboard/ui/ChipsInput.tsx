import { useId, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "./Icon";
import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";
import { FieldError } from "./FieldError";

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
  /** Controlled pending text; omit it and the input keeps its own. */
  pending?: string;
  onPendingChange?: (pending: string) => void;
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
  /** Use commas/newlines so entries may contain spaces, as in FAQ phrases. */
  separator?: "whitespace" | "comma";
}

const normalizeEntry = (entry: string, stripPrefix: string | undefined, normalize: ((entry: string) => string) | undefined): string => {
  let next = normalize?.(entry) ?? entry;
  if (stripPrefix !== undefined && next.startsWith(stripPrefix)) next = next.slice(stripPrefix.length);
  return next;
};

export function ChipsInput({ id: suppliedId, label, values, onChange, pending, onPendingChange, placeholder, hint, error, warning, invalidValues = [], stripPrefix, normalize, validate, removeLabel, disabled = false, messages, listLabel, max, separator = "whitespace" }: ChipsInputProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const disabledReason = useDisabledFieldReason();
  const [localDraft, setDraft] = useState("");
  const draft = pending ?? localDraft;
  const [validationError, setValidationError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const atLimit = max !== undefined && values.length >= max;
  // A rejection belongs to the pending text: once that is cleared (typing, parent reset) it goes too.
  const effectiveError = error ?? (draft.length > 0 ? validationError : null) ?? undefined;
  const effectiveWarning = warning ?? duplicateWarning ?? undefined;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const warningId = `${id}-warning`;
  const prefixed = (entry: string): string => `${stripPrefix ?? ""}${entry}`;
  const splitEntries = (value: string): string[] => value.split(separator === "comma" ? /[,\n]+/u : /[ ,]+/u);
  const containsSeparator = (value: string): boolean => separator === "comma" ? /[,\n]/u.test(value) : /[ ,]/u.test(value);
  const updateDraft = (next: string): void => {
    setDraft(next);
    onPendingChange?.(next);
  };

  const commitEntries = (entries: readonly string[], remainder = ""): void => {
    const nextValues = [...values];
    const rejected: string[] = [];
    let nextError: string | null = null;
    let nextWarning: string | null = null;
    for (const rawEntry of entries) {
      const nextValue = normalizeEntry(rawEntry.trim(), stripPrefix, normalize);
      if (nextValue.length === 0) continue;
      if (nextValues.includes(nextValue)) {
        nextWarning ??= messages.duplicateWarning(prefixed(nextValue));
        continue;
      }
      if (max !== undefined && nextValues.length >= max) {
        // At the limit nothing is committed: keep the text so it is never dropped silently.
        rejected.push(rawEntry.trim());
        nextError ??= messages.atLimitHint;
        continue;
      }
      const invalid = validate?.(nextValue) ?? null;
      if (invalid !== null) {
        rejected.push(rawEntry.trim());
        nextError ??= invalid;
        continue;
      }
      nextValues.push(nextValue);
    }
    if (nextValues.length !== values.length) onChange(nextValues);
    updateDraft([...rejected, remainder].filter((entry) => entry.length > 0).join(", "));
    setValidationError(nextError);
    setDuplicateWarning(nextWarning);
  };

  const add = (): void => {
    commitEntries(splitEntries(draft));
  };

  const handleDraftChange = (next: string): void => {
    const entries = splitEntries(next);
    if (entries.length === 1) {
      updateDraft(next);
      setValidationError(null);
      setDuplicateWarning(null);
      return;
    }
    const trailingSeparator = separator === "comma" ? /[,\n]$/u.test(next) : /[ ,]$/u.test(next);
    const remainder = trailingSeparator ? "" : entries.pop() ?? "";
    commitEntries(entries, remainder);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData("text");
    if (!containsSeparator(pasted)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? draft.length;
    const end = input.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${pasted}${draft.slice(end)}`;
    commitEntries(splitEntries(next));
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
      <input data-ui="" id={id} className="chips-input__input" value={draft} placeholder={placeholder} disabled={disabled} readOnly={atLimit && draft.length === 0} aria-describedby={describedBy} onChange={(event) => { handleDraftChange(event.currentTarget.value); }} onPaste={handlePaste} onKeyDown={handleKeyDown} onBlur={add} />
    </div>
    <span data-ui="" id={descriptionId} className="chips-input__description"><span>{currentHint ?? ""}</span>{max === undefined ? null : <span className="chips-input__count">{messages.countLabel(values.length, max)}</span>}{describedHelper(null, disabledReason, `chips-${id}`)}</span>
    <FieldError id={errorId} className="ui-field__error" message={effectiveError} />
    <span data-ui="" id={warningId} className="chips-input__warning" aria-hidden={effectiveWarning === undefined || undefined}><span>{effectiveWarning ?? ""}</span></span>
  </div>;
}
