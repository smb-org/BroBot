import { useEffect, useState, type ReactNode } from "react";

import { ToastHost } from "./Toast";

interface ShellNavContext {
  openCommandPalette: () => void;
  closeMobileNav: () => void;
}

export interface ShellProps {
  header: (context: ShellNavContext) => ReactNode;
  navbar: (context: ShellNavContext) => ReactNode;
  navLabel: string;
  openSidebarLabel: string;
  closeSidebarLabel: string;
  mode: "live" | "setup";
  commandPaletteOpen: boolean;
  onCommandPaletteOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** Fixed 64px header and 256px setup navigation, with a sheet at narrow widths. */
export function Shell({
  header,
  navbar,
  navLabel,
  openSidebarLabel,
  closeSidebarLabel,
  mode,
  commandPaletteOpen,
  onCommandPaletteOpenChange,
  children,
}: ShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isSetup = mode === "setup";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileNavOpen(false);
        onCommandPaletteOpenChange(!commandPaletteOpen);
      }
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandPaletteOpen, onCommandPaletteOpenChange]);

  const openCommandPalette = (): void => {
    setMobileNavOpen(false);
    onCommandPaletteOpenChange(true);
  };
  const closeMobileNav = (): void => { setMobileNavOpen(false); };

  return (
    <div className={`dashboard-shell dashboard-shell--${mode}`} data-mode={mode}>
      <header className="dashboard-shell__header">
        <div className="dashboard-shell__header-inner">
          {isSetup ? (
            <button
              aria-expanded={mobileNavOpen}
              aria-label={mobileNavOpen ? closeSidebarLabel : openSidebarLabel}
              className="dashboard-shell__burger"
              onClick={() => { setMobileNavOpen((open) => !open); }}
              type="button"
            >
              <span />
              <span />
              <span />
            </button>
          ) : null}
          <div className="dashboard-shell__header-content">{header({ openCommandPalette, closeMobileNav })}</div>
        </div>
      </header>
      <div className={`dashboard-shell__workspace${isSetup ? " has-navigation" : ""}`}>
        {isSetup ? (
          <>
            {mobileNavOpen ? <button aria-label={closeSidebarLabel} className="dashboard-shell__drawer-backdrop" onClick={closeMobileNav} type="button" /> : null}
            <aside className="dashboard-shell__navbar" data-open={mobileNavOpen ? "true" : "false"}>
              <nav aria-label={navLabel}>{navbar({ openCommandPalette, closeMobileNav })}</nav>
            </aside>
          </>
        ) : null}
        <main className="dashboard-shell__main">{children}</main>
      </div>
      <ToastHost />
    </div>
  );
}
