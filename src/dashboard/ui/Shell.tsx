import { AppShell, Burger, Group } from "@mantine/core";
import { useDisclosure, useSessionStorage } from "@mantine/hooks";
import type { ReactNode } from "react";

import { colors } from "./theme";

export interface ShellNavContext {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Called after a navbar entry navigates, so the mobile drawer closes behind it. */
  closeMobileNav: () => void;
}

export interface ShellProps {
  header: ReactNode;
  navbar: (context: ShellNavContext) => ReactNode;
  navLabel: string;
  openSidebarLabel: string;
  closeSidebarLabel: string;
  children: ReactNode;
}

const SIDEBAR_WIDTH_EXPANDED = 240;
const SIDEBAR_WIDTH_COLLAPSED = 80;

/**
 * "Layout" (docs/input/DESIGN-neu.md): the fixed-measure shell -- a 56px
 * header and a 240/80px navbar that becomes a drawer below the `md`
 * breakpoint. Mantine's `AppShell` and `Burger` live here so no page
 * outside `ui/` touches them; panels only ever see `header`/`navbar`
 * content they compose from plain markup and other seam components.
 *
 * The collapsed state "übersteht die Sitzung im Browser" -- session
 * storage, not local storage: it resets when the browser session ends.
 */
export function Shell({ header, navbar, navLabel, openSidebarLabel, closeSidebarLabel, children }: ShellProps) {
  const [collapsed, setCollapsed] = useSessionStorage({
    key: "brobot-dashboard-sidebar-collapsed",
    defaultValue: false,
  });
  const [mobileOpened, { toggle: toggleMobile, close: closeMobile }] = useDisclosure(false);
  const onToggleCollapsed = (): void => { setCollapsed((current) => !current); };

  return (
    <AppShell
      header={{ height: { base: 96, md: 56 } }}
      navbar={{
        width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
        breakpoint: "md",
        collapsed: { mobile: !mobileOpened },
      }}
      padding={0}
      withBorder={false}
    >
      <AppShell.Header style={{ backgroundColor: colors.rail, borderBottom: `1px solid ${colors.hairline}` }}>
        <Group h="100%" gap="sm" wrap="nowrap" px="md">
          <Burger
            opened={mobileOpened}
            onClick={toggleMobile}
            hiddenFrom="md"
            size="sm"
            aria-label={mobileOpened ? closeSidebarLabel : openSidebarLabel}
          />
          <div style={{ flex: 1, minWidth: 0, height: "100%" }}>{header}</div>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar
        aria-label={navLabel}
        style={{ backgroundColor: colors.rail, borderRight: `1px solid ${colors.hairline}` }}
      >
        {navbar({ collapsed, onToggleCollapsed, closeMobileNav: closeMobile })}
      </AppShell.Navbar>
      <AppShell.Main style={{ backgroundColor: colors.ground }}>{children}</AppShell.Main>
    </AppShell>
  );
}
