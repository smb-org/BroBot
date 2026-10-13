import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { isCommandPaletteShortcut } from "../command-palette-shortcut";
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
  const [returnFocusOnClose, setReturnFocusOnClose] = useState(false);
  const mobileBurgerRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLElement>(null);
  const wasMobileNavOpenRef = useRef(false);
  const isSetup = mode === "setup";
  const closeMobileNav = useCallback((): void => {
    setReturnFocusOnClose(true);
    setMobileNavOpen(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isMacPlatform = /Mac|iPhone|iPad|iPod/u.test(navigator.platform || navigator.userAgent);
      if (isCommandPaletteShortcut(event, isMacPlatform)) {
        event.preventDefault();
        if (mobileNavOpen) setMobileNavOpen(false);
        onCommandPaletteOpenChange(!commandPaletteOpen);
      }
      if (event.key === "Escape" && mobileNavOpen) {
        event.preventDefault();
        closeMobileNav();
      }
      if (event.key === "Tab" && mobileNavOpen) {
        const drawer = mobileDrawerRef.current;
        if (drawer === null) return;
        const focusable = [...drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )].filter((element) => element.getAttribute("aria-hidden") !== "true");
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) {
          event.preventDefault();
          drawer.focus();
        } else if (!drawer.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeMobileNav, commandPaletteOpen, mobileNavOpen, onCommandPaletteOpenChange]);

  useLayoutEffect(() => {
    if (mobileNavOpen) {
      wasMobileNavOpenRef.current = true;
      const drawer = mobileDrawerRef.current;
      const first = drawer?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      first?.focus({ preventScroll: true });
      return;
    }
    if (wasMobileNavOpenRef.current) {
      wasMobileNavOpenRef.current = false;
      if (returnFocusOnClose) mobileBurgerRef.current?.focus({ preventScroll: true });
    }
  }, [mobileNavOpen, returnFocusOnClose]);

  const openCommandPalette = (): void => {
    setReturnFocusOnClose(false);
    setMobileNavOpen(false);
    onCommandPaletteOpenChange(true);
  };
  return (
    <div className={`dashboard-shell dashboard-shell--${mode}`} data-mode={mode}>
      <header className="dashboard-shell__header">
        <div className="dashboard-shell__header-inner">
          {isSetup ? (
            <button
              aria-expanded={mobileNavOpen}
              aria-label={mobileNavOpen ? closeSidebarLabel : openSidebarLabel}
              className="dashboard-shell__burger"
              ref={mobileBurgerRef}
              onClick={() => { setReturnFocusOnClose(false); setMobileNavOpen((open) => !open); }}
              type="button"
            >
              <span />
              <span />
              <span />
            </button>
          ) : null}
          <div className="dashboard-shell__header-content" inert={mobileNavOpen}>{header({ openCommandPalette, closeMobileNav })}</div>
        </div>
      </header>
      <div className={`dashboard-shell__workspace${isSetup ? " has-navigation" : ""}`}>
        {isSetup ? (
          <>
            {mobileNavOpen ? <button aria-hidden="true" className="dashboard-shell__drawer-backdrop" onClick={closeMobileNav} tabIndex={-1} type="button" /> : null}
            <aside
              aria-label={mobileNavOpen ? navLabel : undefined}
              aria-modal={mobileNavOpen ? "true" : undefined}
              className="dashboard-shell__navbar"
              data-open={mobileNavOpen ? "true" : "false"}
              ref={mobileDrawerRef}
              role={mobileNavOpen ? "dialog" : undefined}
              tabIndex={-1}
            >
              <nav aria-label={navLabel}>{navbar({ openCommandPalette, closeMobileNav })}</nav>
            </aside>
          </>
        ) : null}
        <main className="dashboard-shell__main" inert={mobileNavOpen}>{children}</main>
      </div>
      <ToastHost />
    </div>
  );
}
