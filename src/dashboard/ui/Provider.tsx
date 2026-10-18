import "./tokens.css";

import type { ReactNode } from "react";

/**
 * The panel's visual provider. Dashboard data context is composed in main.tsx
 * so shared UI modules do not add query dependencies to overlay chunks.
 */
export function UiProvider({ children }: { children: ReactNode }) {
  return children;
}
