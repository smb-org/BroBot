import type { ReactElement } from "react";

import { useDisabledFieldReason } from "./DisabledFieldReason";

export interface ColorFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ColorField({ id, label, value, onChange, disabled = false }: ColorFieldProps): ReactElement {
  const disabledReason = useDisabledFieldReason();
  const reasonId = disabledReason === null ? undefined : `${disabledReason.id}-color-${id}`;
  return <label className="ui-color-field" htmlFor={id}>
    <span>{label}</span>
    <input id={id} type="color" aria-label={label} value={value} disabled={disabled}
      aria-describedby={reasonId}
      onChange={(event) => { onChange(event.currentTarget.value); }} />
    {disabledReason === null ? null : <span className="sr-only" id={reasonId}>{disabledReason.reason}</span>}
  </label>;
}
