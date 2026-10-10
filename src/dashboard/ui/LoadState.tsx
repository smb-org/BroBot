import type { CSSProperties, ReactNode } from "react";

import { QueryErrorState, type QueryError } from "./QueryErrorState";

export type LoadStateKind = "loading" | "empty" | "error" | "success";

export interface LoadStateProps {
  status: LoadStateKind;
  minHeight: CSSProperties["minHeight"];
  loading: ReactNode;
  empty: ReactNode;
  error: ReactNode;
  children: ReactNode;
  queryError?: QueryError;
  /** Reserves the refresh slot when present and shows its error when true. */
  refreshError?: boolean;
}

/** Keeps state content and its optional recovery slot at a stable position. */
export function LoadState({ status, minHeight, loading, empty, error, children, queryError, refreshError }: LoadStateProps) {
  const contentMinHeight = typeof minHeight === "number" ? `${String(minHeight)}px` : minHeight;
  const hasRefreshSlot = refreshError !== undefined;
  const layoutStyle: CSSProperties = !hasRefreshSlot
    ? { minHeight }
    : {
      minHeight: "calc(var(--ui-load-state-content-min-height) + var(--s10))",
      "--ui-load-state-content-min-height": contentMinHeight,
    } as CSSProperties;
  const content = status === "loading" ? loading
    : status === "empty" ? empty
      : status === "error" ? queryError === undefined ? error : <QueryErrorState mode="initial" error={queryError} />
        : children;

  return (
    <div className={`ui-load-state${hasRefreshSlot ? " ui-load-state--retry" : ""}`} data-status={status} aria-busy={status === "loading"} style={layoutStyle}>
      <div className="ui-load-state__content" style={hasRefreshSlot ? { minHeight: contentMinHeight } : undefined}>{content}</div>
      {!hasRefreshSlot ? null : <div className="ui-load-state__retry-slot">
        {status === "error" || queryError === undefined
          ? null
          : <QueryErrorState mode="refresh" placement="load-state" error={refreshError ? queryError : null} />}
      </div>}
    </div>
  );
}
