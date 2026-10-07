import type { ReactNode } from "react";

import { formatNumber } from "../locale";

export function ListPaginationFooter({
  loadedCount,
  loadedLabel,
  children,
}: {
  loadedCount: number;
  loadedLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="list-pagination-footer">
      <span className="list-pagination-footer__count">
        <span className="mono">{formatNumber(loadedCount)}</span> {loadedLabel}
      </span>
      <div className="list-pagination-footer__action">{children}</div>
    </div>
  );
}
