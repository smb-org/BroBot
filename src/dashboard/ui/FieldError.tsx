import type { ReactNode } from "react";

import { TruncatedText } from "./TruncatedText";

export interface FieldErrorProps {
  message?: ReactNode;
  id?: string;
  className?: string;
}

export function FieldError({ message, id, className }: FieldErrorProps) {
  const hasMessage = message !== undefined && message !== null && message !== "";
  const classes = ["ui-field-error", className].filter(Boolean).join(" ");

  return <span data-ui="" id={id} className={classes} aria-live="polite" role={hasMessage ? "alert" : undefined}>
    {hasMessage ? <><span aria-hidden="true">× </span>{typeof message === "string" ? <TruncatedText text={message} /> : message}</> : <span aria-hidden="true">&nbsp;</span>}
  </span>;
}
