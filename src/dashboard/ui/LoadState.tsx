import type { CSSProperties, ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";
import { ErrorPanel } from "./ErrorPanel";

export type LoadStateKind = "loading" | "empty" | "error" | "success";
export type LoadStateVariant =
  | "status-row"
  | "compact-64"
  | "feed-132"
  | "panel-178"
  | "panel-200"
  | "panel-220"
  | "panel-260"
  | "panel-280"
  | "panel-320"
  | "panel-360"
  | "panel-420"
  | "panel-480"
  | "panel-600"
  | "panel-640"
  | "panel-720"
  | "panel-960"
  | "panel-1000"
  | "panel-1200"
  | "panel-0";

export interface QueryError {
  title?: string;
  message: string;
  onRetry: () => void;
}

interface LoadStateContentProps {
  status: LoadStateKind;
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

export type LoadStateProps = LoadStateContentProps & (
  { variant: LoadStateVariant }
);

interface LoadStateVariantDefinition {
  minHeight: CSSProperties["minHeight"];
  presentation: "compact" | "panel";
  reservesRefreshRow: boolean;
  showsRefreshErrorInContent: boolean;
}

const loadStateVariants = {
  "status-row": { minHeight: "var(--s5)", presentation: "compact", reservesRefreshRow: false, showsRefreshErrorInContent: false },
  "compact-64": { minHeight: "calc(var(--s6) + var(--s10))", presentation: "compact", reservesRefreshRow: false, showsRefreshErrorInContent: true },
  "feed-132": { minHeight: "calc(var(--s10) * 3 + var(--s3))", presentation: "compact", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-178": { minHeight: "178px", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-200": { minHeight: "200px", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-220": { minHeight: "220px", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-260": { minHeight: "260px", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-280": { minHeight: "280px", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-320": { minHeight: "calc(var(--s10) * 8)", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-360": { minHeight: "360px", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-420": { minHeight: "420px", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-480": { minHeight: "calc(var(--s10) * 12)", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-600": { minHeight: "calc(var(--s10) * 15)", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-640": { minHeight: "calc(var(--s10) * 16)", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-720": { minHeight: "calc(var(--s10) * 18)", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-960": { minHeight: "calc(var(--s10) * 24)", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-1000": { minHeight: "calc(var(--s10) * 25)", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-1200": { minHeight: "calc(var(--s10) * 30)", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
  "panel-0": { minHeight: "0px", presentation: "panel", reservesRefreshRow: true, showsRefreshErrorInContent: false },
} as const satisfies Record<LoadStateVariant, LoadStateVariantDefinition>;

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
export function LoadState({ variant, status, loading, empty, error, children, queryError, refreshError, trailing, className }: LoadStateProps) {
  const variantDefinition = loadStateVariants[variant];
  const contentMinHeight = variantDefinition.minHeight;
  const hasRefreshSlot = variantDefinition.reservesRefreshRow && refreshError !== undefined;
  const layoutStyle: CSSProperties = !hasRefreshSlot
    ? { minHeight: contentMinHeight }
    : {
        minHeight: "calc(var(--ui-load-state-content-min-height) + var(--s10))",
        "--ui-load-state-content-min-height": contentMinHeight,
      } as CSSProperties;
  const refreshErrorState = refreshError === true && queryError !== undefined;
  const content = status === "loading" ? loading
    : status === "empty" ? empty
      : status === "error" ? queryError === undefined ? error
        : variantDefinition.presentation === "compact" ? inlineError(queryError, trailing)
          : <div role="alert"><ErrorPanel title={queryError.title ?? dashboardCommonTexts().error} reason={queryError.message} action={{ label: dashboardCommonTexts().retry, onClick: queryError.onRetry }} /></div>
        : variantDefinition.showsRefreshErrorInContent && refreshErrorState ? inlineError(queryError, trailing) : children;

  return (
    <div className={["ui-load-state", `ui-load-state--${variantDefinition.presentation}`, `ui-load-state--${variant}`, hasRefreshSlot ? "ui-load-state--retry" : "", className].filter(Boolean).join(" ")} data-variant={variant} data-status={status} aria-busy={status === "loading"} style={layoutStyle}>
      <div className="ui-load-state__content" style={hasRefreshSlot ? { minHeight: contentMinHeight } : undefined}>{content}</div>
      {!hasRefreshSlot ? null : <div className="ui-load-state__retry-slot">
        {status === "error" || queryError === undefined || !refreshErrorState ? null : inlineError(queryError, trailing)}
      </div>}
    </div>
  );
}
