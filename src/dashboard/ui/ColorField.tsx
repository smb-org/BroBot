import { useEffect, useRef, type ReactElement } from "react";

import { Button } from "./Button";
import { useDisabledFieldReason } from "./DisabledFieldReason";

export interface ColorFieldProps {
  id: string;
  label: string;
  value: string | undefined;
  unsetLabel: string;
  clearLabel: string;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  allowTransparent?: boolean;
  transparentLabel?: string;
}

const colorForInput = (value: string | undefined, fallback: string): string => {
  if (value === undefined || value === "transparent") return fallback;
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value)) return value.slice(0, 7);
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\d{1,2}%|100%))?\s*\)$/iu.exec(value);
  if (rgb === null) return fallback;
  return `#${rgb.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
};

export function ColorField({
  id,
  label,
  value,
  unsetLabel,
  clearLabel,
  onChange,
  disabled = false,
  allowTransparent = false,
  transparentLabel,
}: ColorFieldProps): ReactElement {
  const disabledReason = useDisabledFieldReason();
  const defaultColor = getComputedStyle(document.documentElement).getPropertyValue("--content-default").trim();
  const inputValue = colorForInput(value, defaultColor);
  const lastSolidValue = useRef(value !== undefined && value !== "transparent" ? value : inputValue);
  const isTransparent = allowTransparent && value === "transparent";
  useEffect(() => {
    if (!isTransparent && value !== undefined) lastSolidValue.current = value;
  }, [isTransparent, value]);
  const reasonId = disabledReason === null ? undefined : `${disabledReason.id}-color-${id}`;
  const unsetDescriptionId = `${id}-unset-note`;
  const describedBy = [reasonId, value === undefined ? unsetDescriptionId : undefined].filter((descriptionId) => descriptionId !== undefined).join(" ") || undefined;
  return <div data-ui="" className="ui-color-field">
    <label htmlFor={id}>{label}</label>
    <div className="ui-color-field__controls">
      <span className="ui-color-field__swatch" data-unset={value === undefined} data-disabled={disabled}>
        <input id={id} type="color" aria-label={label} value={inputValue} data-unset={value === undefined} disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => { lastSolidValue.current = event.currentTarget.value; onChange(event.currentTarget.value); }} />
        {value === undefined ? <span className="ui-color-field__empty-swatch" aria-hidden="true" /> : null}
      </span>
      {allowTransparent && transparentLabel !== undefined ? <label className="ui-color-field__transparent" htmlFor={`${id}-transparent`}>
        <input id={`${id}-transparent`} type="checkbox" checked={isTransparent} disabled={disabled}
          onChange={(event) => { onChange(event.currentTarget.checked ? "transparent" : lastSolidValue.current); }} />
        <span>{transparentLabel}</span>
      </label> : null}
      {value === undefined
        ? <span className="ui-color-field__unset" id={unsetDescriptionId} role="note">{unsetLabel}</span>
        // Icon-only so swatch + clear fit on one line in a half-width column (#237);
        // `title` gives it a native tooltip on top of the `ariaLabel` accessible name.
        : <Button icon="close" iconOnly ariaLabel={clearLabel} title={clearLabel} disabled={disabled}
          {...(reasonId === undefined ? {} : { describedBy: reasonId })} onClick={() => { onChange(undefined); }} />}
      {disabledReason === null ? null : <span className="sr-only" id={reasonId}>{disabledReason.reason}</span>}
    </div>
  </div>;
}
