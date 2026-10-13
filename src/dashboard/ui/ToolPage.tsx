import type { ReactElement, ReactNode } from "react";

import { PageHeader } from "./PageHeader";
import type { PageHeaderProps } from "./PageHeader";

export interface ToolPageProps extends PageHeaderProps {
  children: ReactNode;
}

export function ToolPage({ children, ...header }: ToolPageProps): ReactElement {
  return (
    <div data-ui="" className="tool-page">
      <PageHeader {...header} />
      <div className="tool-page__body">{children}</div>
    </div>
  );
}
