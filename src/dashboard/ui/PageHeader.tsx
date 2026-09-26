import type { ReactNode } from "react";

import { NavigationIcon } from "./NavigationIcon";

export interface PageHeaderProps {
  kind: string;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}

export function PageHeader({ kind, title, subtitle, actions, icon }: PageHeaderProps) {
  return (
    <header className="page-header module-detail-heading">
      <div className="page-header__icon module-detail-heading__icon" aria-hidden="true">
        {icon ?? <NavigationIcon kind={kind} className="module-heading-glyph" />}
      </div>
      <div className="page-header__copy module-detail-heading__copy">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {actions === undefined ? null : <div className="page-header__actions module-detail-heading__actions">{actions}</div>}
    </header>
  );
}
