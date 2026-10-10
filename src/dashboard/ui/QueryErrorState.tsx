import type { ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";
import { Button } from "./Button";
import { ErrorPanel } from "./ErrorPanel";

export interface QueryError {
  title?: string;
  message: string;
  onRetry: () => void;
}

export type QueryErrorStateProps =
  | { mode: "initial"; error: QueryError }
  | {
    mode: "refresh";
    error: QueryError | null;
    placement: "toolbar" | "status-row" | "load-state";
    trailing?: ReactNode;
  };

/** Presents query errors consistently in initial and reserved refresh slots. */
export function QueryErrorState(properties: QueryErrorStateProps) {
  if (properties.mode === "initial") {
    const { error } = properties;
    return <div role="alert"><ErrorPanel title={error.title ?? dashboardCommonTexts().error} reason={error.message} action={{ label: dashboardCommonTexts().retry, onClick: error.onRetry }} /></div>;
  }

  const { error, placement } = properties;
  const className = `query-error-state query-error-state--${placement}`;
  if (error === null) return <div className={className} aria-live="polite" />;

  return (
    <div className={className} aria-live="polite">
      <span className="query-error-state__message" role="alert" title={error.message}>{error.message}</span>
      <div className="query-error-state__actions">
        {properties.trailing}
        {placement === "load-state" ? (
          <Button size="compact" variant="neutral" onClick={error.onRetry}>{dashboardCommonTexts().retry}</Button>
        ) : (
          <button className="query-error-state__retry" type="button" onClick={error.onRetry}>{dashboardCommonTexts().retry}</button>
        )}
      </div>
    </div>
  );
}
