import { AppShell, Burger } from "@mantine/core";
import { useDisclosure, useSessionStorage } from "@mantine/hooks";
import type { ReactNode } from "react";

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
 * desktop header and a 240/80px navbar that becomes a drawer below the `md`
 * breakpoint. The static shell grid lets the rail paint beside the full
 * document; its navigation contents remain sticky. Mantine's AppShell and Burger live here so no page
 * outside `ui/` touches them; panels only ever see `header`/`navbar`
 * content they compose from plain markup and other seam components.
 *
 * The collapsed state "survives the session in the browser" -- session
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
      className="dashboard-shell"
      mode="static"
      header={{ height: { base: 112, md: 56 } }}
      navbar={{
        width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
        breakpoint: "md",
        collapsed: { mobile: !mobileOpened },
      }}
      padding={0}
      withBorder={false}
    >
      <AppShell.Header className="dashboard-shell__header">
        <div className="dashboard-shell__header-inner">
          <Burger
            opened={mobileOpened}
            onClick={toggleMobile}
            hiddenFrom="md"
            size="sm"
            aria-label={mobileOpened ? closeSidebarLabel : openSidebarLabel}
          />
          <div className="dashboard-shell__header-content">{header}</div>
        </div>
      </AppShell.Header>
      <AppShell.Navbar
        className="dashboard-shell__navbar"
        aria-label={navLabel}
      >
        {navbar({ collapsed, onToggleCollapsed, closeMobileNav: closeMobile })}
      </AppShell.Navbar>
      <AppShell.Main className="dashboard-shell__main">{children}</AppShell.Main>
    </AppShell>
  );
}
