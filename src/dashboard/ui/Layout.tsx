import { Grid as MantineGrid, Group as MantineGroup, Stack as MantineStack } from "@mantine/core";

/**
 * Layout primitives re-exported as-is: `Stack`, `Group` and `Grid` are
 * already project vocabulary -- a panel builds its layout from these
 * instead of reaching for Mantine's grid directly ("The seam" in
 * docs/input/DESIGN-neu.md).
 */
export const Stack = MantineStack;
export const Group = MantineGroup;
export const Grid = MantineGrid;
