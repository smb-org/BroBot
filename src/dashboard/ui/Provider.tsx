import "./tokens.css";

import { MantineProvider } from "@mantine/core";
import { useMemo, type ReactNode } from "react";

import { createDashboardTheme } from "./theme";

/**
 * The panel's visual provider. Dashboard data context is composed in main.tsx
 * so shared UI modules do not add query dependencies to overlay chunks.
 */
export function UiProvider({ children }: { children: ReactNode }) {
  const theme = useMemo(() => createDashboardTheme((variable) =>
    getComputedStyle(document.documentElement).getPropertyValue(variable),
  ), []);

  return (
    <MantineProvider theme={theme} forceColorScheme="dark">
      {children}
    </MantineProvider>
  );
}
