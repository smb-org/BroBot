import { Grid as MantineGrid, Group as MantineGroup, Stack as MantineStack } from "@mantine/core";
import type { ComponentProps } from "react";

/**
 * Layout primitives in project vocabulary. Each marks its own root so the
 * base reset stays inside the component tree that opts into the UI system.
 */
export const Stack = (props: ComponentProps<typeof MantineStack>) => <MantineStack {...props} data-ui="" />;
export const Group = (props: ComponentProps<typeof MantineGroup>) => <MantineGroup {...props} data-ui="" />;
export const Grid = (props: ComponentProps<typeof MantineGrid>) => <MantineGrid {...props} data-ui="" />;
