import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";

import { theme } from "./theme";

/**
 * The one place the panel touches `MantineProvider` directly. Dark only:
 * no toggle, no unrequested light variant ("Farbschema und Grundton" in
 * docs/input/DESIGN-neu.md).
 */
export function UiProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider theme={theme} forceColorScheme="dark">
      {children}
    </MantineProvider>
  );
}
