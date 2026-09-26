import type { ReactNode } from "react";

export function FilterBar({ label, children, className, summary }: { label: string; children: ReactNode; className?: string; summary?: ReactNode }) {
  return (
    <div className={`dashboard-filter-bar${className === undefined ? "" : ` ${className}`}`}>
      <div className="dashboard-filter-bar__controls" role="group" aria-label={label}>{children}</div>
      {summary === undefined ? null : <div className="dashboard-filter-bar__summary">{summary}</div>}
    </div>
  );
}
