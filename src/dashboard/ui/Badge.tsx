import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "brand" | "green" | "amber" | "red";

export function Badge({ tone = "neutral", children, mono = false }: { tone?: BadgeTone; children: ReactNode; mono?: boolean }) {
  return <span className={`ui-badge ui-badge--${tone}${mono ? " ui-badge--mono" : ""}`}>{children}</span>;
}
