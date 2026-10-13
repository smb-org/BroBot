import type { ReactElement, ReactNode } from "react";

import { PageHeader } from "./PageHeader";
import type { PageHeaderProps } from "./PageHeader";

export interface SettingsPageProps extends PageHeaderProps {
  columns: readonly ReactNode[];
}

export function SettingsPage({ columns, ...header }: SettingsPageProps): ReactElement {
  const columnCount = Math.max(1, Math.min(columns.length, 4));
  return (
    <div data-ui="" className="settings-page">
      <PageHeader {...header} />
      <div className={`settings-page__columns settings-page__columns--${String(columnCount)}`}>
        {columns.map((column, index) => <div className="settings-page__column" key={index}>{column}</div>)}
      </div>
    </div>
  );
}
