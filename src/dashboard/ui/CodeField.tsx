import type { ReactElement } from "react";

import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";
import { Textarea } from "./primitives/textarea";

export interface CodeFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  disabled?: boolean;
  className?: string;
}

export function CodeField({ id, label, value, onChange, maxLength, disabled = false, className }: CodeFieldProps): ReactElement {
  const disabledReason = useDisabledFieldReason();
  const describedBy = disabledReason === null ? undefined : `${disabledReason.id}-code-${id}`;
  return <div data-ui="" className={`ui-code-field${className === undefined ? "" : ` ${className}`}`}>
    <label className="ui-field__label" htmlFor={id}>{label}</label>
    <Textarea id={id} className="ui-code-field__input" value={value} maxLength={maxLength} rows={14} disabled={disabled} aria-describedby={describedBy} onChange={(event) => { onChange(event.currentTarget.value); }} />
    {disabledReason === null ? null : <span data-ui="" className="ui-field__description">{describedHelper(null, disabledReason, `code-${id}`)}</span>}
  </div>;
}
