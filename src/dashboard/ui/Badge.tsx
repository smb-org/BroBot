import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "brand" | "chat" | "participation" | "green" | "amber" | "red";

export function Badge({ tone = "neutral", children, mono = false, className }: { tone?: BadgeTone; children: ReactNode; mono?: boolean; className?: string }) {
  return <span data-ui="" className={["ui-badge", `ui-badge--${tone}`, mono ? "ui-badge--mono" : "", className].filter(Boolean).join(" ")}>{children}</span>;
}
