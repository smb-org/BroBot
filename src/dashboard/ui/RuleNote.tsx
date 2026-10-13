import type { ReactNode } from "react";

import { Icon } from "./Icon";

export function RuleNote({ children, className }: { children: ReactNode; className?: string }) {
  return <div data-ui="" className={["ui-rule-note", className].filter(Boolean).join(" ")} role="note">
    <Icon name="cause" size={16} />
    <div>{children}</div>
  </div>;
}
