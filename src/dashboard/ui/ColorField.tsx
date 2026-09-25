import type { ReactElement } from "react";

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
}

export function ColorField({ id, label, value, unsetLabel, clearLabel, onChange, disabled = false }: ColorFieldProps): ReactElement {
  const disabledReason = useDisabledFieldReason();
  const reasonId = disabledReason === null ? undefined : `${disabledReason.id}-color-${id}`;
  const unsetDescriptionId = `${id}-unset-note`;
  const describedBy = [reasonId, value === undefined ? unsetDescriptionId : undefined].filter((descriptionId) => descriptionId !== undefined).join(" ") || undefined;
  return <div className="ui-color-field">
    <label htmlFor={id}>{label}</label>
    <div className="ui-color-field__controls">
      <span className="ui-color-field__swatch" data-unset={value === undefined} data-disabled={disabled}>
        <input id={id} type="color" aria-label={label} value={value ?? "#ffffff"} data-unset={value === undefined} disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => { onChange(event.currentTarget.value); }} />
        {value === undefined ? <span className="ui-color-field__empty-swatch" aria-hidden="true" /> : null}
      </span>
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
