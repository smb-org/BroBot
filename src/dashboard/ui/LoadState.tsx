import type { CSSProperties, ReactNode } from "react";

export type LoadStateKind = "loading" | "empty" | "error" | "success";

export interface LoadStateProps {
  status: LoadStateKind;
  minHeight: CSSProperties["minHeight"];
  loading: ReactNode;
  empty: ReactNode;
  error: ReactNode;
  children: ReactNode;
}

/** Keeps the same minimum content height while loading, empty, error, or loaded content is shown. */
export function LoadState({ status, minHeight, loading, empty, error, children }: LoadStateProps) {
  const content = status === "loading" ? loading
    : status === "empty" ? empty
      : status === "error" ? error
        : children;

  return (
    <div className="ui-load-state" data-status={status} aria-busy={status === "loading"} style={{ minHeight }}>
      {content}
    </div>
  );
}
