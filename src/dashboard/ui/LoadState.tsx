import type { CSSProperties, ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";
import { ErrorPanel } from "./ErrorPanel";

export type LoadStateKind = "loading" | "empty" | "error" | "success";
export type LoadStateVariant = "compact" | "panel";

export interface QueryError {
  title?: string;
  message: string;
  onRetry: () => void;
}

export interface LoadStateProps {
  variant: LoadStateVariant;
  status: LoadStateKind;
  minHeight: CSSProperties["minHeight"];
  loading: ReactNode;
  empty: ReactNode;
  error: ReactNode;
  children: ReactNode;
  queryError?: QueryError;
  /** Declares a reserved refresh row; its presence is stable across query states. */
  refreshError?: boolean;
  trailing?: ReactNode;
  className?: string;
}

const inlineError = (queryError: QueryError, trailing?: ReactNode) => (
  <div className="ui-load-state__inline-error" aria-live="polite">
    <span className="ui-load-state__inline-message" role="alert" title={queryError.message}>{queryError.message}</span>
    <div className="ui-load-state__inline-actions">
      {trailing}
      <button className="ui-load-state__retry" type="button" onClick={queryError.onRetry}>{dashboardCommonTexts().retry}</button>
    </div>
  </div>
);

/** Keeps loading, error, and success states inside the caller's declared box. */
export function LoadState({ variant, status, minHeight, loading, empty, error, children, queryError, refreshError, trailing, className }: LoadStateProps) {
  const contentMinHeight = typeof minHeight === "number" ? `${String(minHeight)}px` : minHeight;
  const hasRefreshSlot = variant === "panel" && refreshError !== undefined;
  const layoutStyle: CSSProperties = !hasRefreshSlot
    ? { minHeight }
    : {
        minHeight: "calc(var(--ui-load-state-content-min-height) + var(--s10))",
        "--ui-load-state-content-min-height": contentMinHeight,
      } as CSSProperties;
  const refreshErrorState = refreshError === true && queryError !== undefined;
  const content = status === "loading" ? loading
    : status === "empty" ? empty
      : status === "error" ? queryError === undefined ? error
        : variant === "compact" ? inlineError(queryError, trailing)
          : <div role="alert"><ErrorPanel title={queryError.title ?? dashboardCommonTexts().error} reason={queryError.message} action={{ label: dashboardCommonTexts().retry, onClick: queryError.onRetry }} /></div>
        : variant === "compact" && refreshErrorState ? inlineError(queryError, trailing) : children;

  return (
    <div className={["ui-load-state", `ui-load-state--${variant}`, hasRefreshSlot ? "ui-load-state--retry" : "", className].filter(Boolean).join(" ")} data-variant={variant} data-status={status} aria-busy={status === "loading"} style={layoutStyle}>
      <div className="ui-load-state__content" style={hasRefreshSlot ? { minHeight: contentMinHeight } : undefined}>{content}</div>
      {!hasRefreshSlot ? null : <div className="ui-load-state__retry-slot">
        {status === "error" || queryError === undefined || !refreshErrorState ? null : inlineError(queryError, trailing)}
      </div>}
    </div>
  );
}
