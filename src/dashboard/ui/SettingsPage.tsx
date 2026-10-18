import type { ReactElement, ReactNode } from "react";

import "./SettingsPage.css";

import { PageHeader } from "./PageHeader";
import type { PageHeaderProps } from "./PageHeader";

export interface SettingsPageProps extends PageHeaderProps {
  columns: readonly ReactNode[];
  topContent?: ReactNode;
  className?: string;
}

export function SettingsPage({ columns, topContent, className, ...header }: SettingsPageProps): ReactElement {
  const columnCount = Math.max(1, Math.min(columns.length, 4));
  return (
    <div data-ui="" className={className === undefined ? "settings-page" : `settings-page ${className}`}>
      <PageHeader {...header} />
      {topContent === undefined ? null : <div className="settings-page__top">{topContent}</div>}
      <div className={`settings-page__columns settings-page__columns--${String(columnCount)}`}>
        {columns.map((column, index) => <div className="settings-page__column" key={index}>{column}</div>)}
      </div>
    </div>
  );
}
