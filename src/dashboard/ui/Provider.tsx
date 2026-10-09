import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";

import { theme } from "./theme";

/**
 * The panel's visual provider. Dashboard data context is composed in main.tsx
 * so shared UI modules do not add query dependencies to overlay chunks.
 */
export function UiProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider theme={theme} forceColorScheme="dark">
      {children}
    </MantineProvider>
  );
}
