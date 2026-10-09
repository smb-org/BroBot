import type { ReactElement } from "react";

export interface QueryStatusRowProperties {
  message: string | null;
  retryLabel: string;
  onRetry: () => void;
}

/** Keeps a retry action in a fixed-height slot when a background read fails. */
export function QueryStatusRow({ message, retryLabel, onRetry }: QueryStatusRowProperties): ReactElement {
  return <div className="query-status-row" aria-live="polite">
    {message === null ? null : <>
      <span className="query-status-row__message" role="alert">{message}</span>
      <button className="list-toolbar__reset" type="button" onClick={onRetry}>{retryLabel}</button>
    </>}
  </div>;
}
