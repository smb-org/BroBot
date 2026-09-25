import { Textarea as MantineTextarea } from "@mantine/core";
import type { ReactElement } from "react";

import { describedHelper, useDisabledFieldReason } from "./DisabledFieldReason";

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
  return <MantineTextarea id={id} className={className} label={label} value={value} maxLength={maxLength}
    disabled={disabled} onChange={(event) => { onChange(event.currentTarget.value); }}
    aria-describedby={disabledReason === null ? undefined : `${disabledReason.id}-code-${id}`}
    description={disabledReason === null ? undefined : describedHelper(null, disabledReason, `code-${id}`)}
    inputWrapperOrder={["label", "input", "description", "error"]} autosize={false} minRows={14} />;
}
