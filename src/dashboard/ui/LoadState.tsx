import type { CSSProperties, ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";
import { Button } from "./Button";

export type LoadStateKind = "loading" | "empty" | "error" | "success";

export interface LoadStateProps {
  status: LoadStateKind;
  minHeight: CSSProperties["minHeight"];
  loading: ReactNode;
  empty: ReactNode;
  error: ReactNode;
  children: ReactNode;
  /** Refetches the query represented by this state. Keeps a fixed action slot in the layout. */
  onRetry?: () => void;
  /** Shows the error and retry action while preserving already loaded content. */
  refreshError?: boolean;
}

/** Keeps state content and its optional recovery slot at a stable position. */
export function LoadState({ status, minHeight, loading, empty, error, children, onRetry, refreshError = false }: LoadStateProps) {
  const contentMinHeight = typeof minHeight === "number" ? `${String(minHeight)}px` : minHeight;
  const layoutStyle: CSSProperties = onRetry === undefined
    ? { minHeight }
    : {
      minHeight: "calc(var(--ui-load-state-content-min-height) + var(--s10))",
      "--ui-load-state-content-min-height": contentMinHeight,
    } as CSSProperties;
  const content = status === "loading" ? loading
    : status === "empty" ? empty
      : status === "error" ? error
        : children;

  return (
    <div className={`ui-load-state${onRetry === undefined ? "" : " ui-load-state--retry"}`} data-status={status} aria-busy={status === "loading"} style={layoutStyle}>
      <div className="ui-load-state__content" style={onRetry === undefined ? undefined : { minHeight: contentMinHeight }}>{content}</div>
      {onRetry === undefined ? null : <div className="ui-load-state__retry-slot" aria-live="polite">
        {refreshError && status !== "error" ? <div className="ui-load-state__refresh-error">{error}</div> : null}
        {status === "error" || refreshError
          ? <Button size="compact" variant="neutral" onClick={onRetry}>{dashboardCommonTexts().retry}</Button>
          : null}
      </div>}
    </div>
  );
}
