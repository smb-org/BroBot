import { useId, type KeyboardEvent } from "react";

import { Icon } from "./Icon";

export interface SegmentChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface SegmentChoiceProps<T extends string = string> {
  label: string;
  hint?: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly ({ value: T; label: string; description?: string })[];
  size?: "form" | "compact";
  disabled?: boolean;
  warning?: string;
}

export function SegmentChoice<T extends string>({ label, hint, value, onChange, options, size = "form", disabled = false, warning }: SegmentChoiceProps<T>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const warningId = `${id}-warning`;
  const describedBy = [hint === undefined ? null : hintId, warning === undefined ? null : warningId].filter((part): part is string => part !== null).join(" ") || undefined;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0 || disabled || options.length < 2) return;
    const currentValue = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-value]")?.dataset.value;
    const currentIndex = Math.max(0, options.findIndex((option) => option.value === currentValue));
    const nextIndex = (currentIndex + delta + options.length) % options.length;
    const next = options[nextIndex];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next.value);
    const nextButton = event.currentTarget.children.item(nextIndex);
    if (nextButton instanceof HTMLButtonElement) nextButton.focus();
  };

  return <div data-ui="" className={`segment-choice-field segment-choice-field--${size}`}>
    <span className="segment-choice-field__label" id={`${id}-label`}>{label}</span>
    <div data-ui="" className="segment-choice" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} onKeyDown={handleKeyDown}>
      {options.map((option) => <button
        key={option.value}
        type="button"
        data-value={option.value}
        className={`segment-choice__option${value === option.value ? " is-selected" : ""}`}
        aria-pressed={value === option.value}
        disabled={disabled}
        onClick={() => { onChange(option.value); }}
      >
        <span className="segment-choice__label">{option.label}</span>
        {option.description === undefined ? null : <span className="segment-choice__description">{option.description}</span>}
      </button>)}
    </div>
    {hint === undefined ? <span className="segment-choice-field__hint" aria-hidden="true">&nbsp;</span> : <span id={hintId} className="segment-choice-field__hint">{hint}</span>}
    {warning === undefined ? <span className="segment-choice-field__warning" aria-hidden="true">&nbsp;</span> : <span id={warningId} className="segment-choice-field__warning"><Icon name="warning" size={16} />{warning}</span>}
  </div>;
}
