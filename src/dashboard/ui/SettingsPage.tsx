import type { ReactElement, ReactNode } from "react";

import { PageHeader } from "./PageHeader";
import type { PageHeaderProps } from "./PageHeader";

export interface SettingsPageProps extends PageHeaderProps {
  columns: readonly ReactNode[];
  topContent?: ReactNode;
}

export function SettingsPage({ columns, topContent, ...header }: SettingsPageProps): ReactElement {
  const columnCount = Math.max(1, Math.min(columns.length, 4));
  return (
    <div data-ui="" className="settings-page">
      <PageHeader {...header} />
      {topContent === undefined ? null : <div className="settings-page__top">{topContent}</div>}
      <div className={`settings-page__columns settings-page__columns--${String(columnCount)}`}>
        {columns.map((column, index) => <div className="settings-page__column" key={index}>{column}</div>)}
      </div>
    </div>
  );
}
