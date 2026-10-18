import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { isCommandPaletteShortcut } from "../command-palette-shortcut";
import { ToastHost } from "./Toast";

// Must match the `max-width` of the drawer rules in core.css (`.dashboard-shell__burger { display: flex }`).
const MOBILE_LAYOUT_QUERY = "(max-width: 768px)";

function subscribeMobileLayout(onChange: () => void): () => void {
  const query = window.matchMedia(MOBILE_LAYOUT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const getMobileLayout = (): boolean => window.matchMedia(MOBILE_LAYOUT_QUERY).matches;

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
  focusKey?: string;
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
  focusKey,
  children,
}: ShellProps) {
  const [navRequested, setMobileNavOpen] = useState(false);
  const [returnFocusOnClose, setReturnFocusOnClose] = useState(false);
  const mobileBurgerRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const wasMobileNavOpenRef = useRef(false);
  const focusMainAfterMobileCloseRef = useRef(false);
  const previousFocusKeyRef = useRef(focusKey);
  const initialRouteFocusHandledRef = useRef(false);
  const isSetup = mode === "setup";
  // Derived: the drawer only exists in setup mode, so `inert` can never outlive it.
  const isMobileLayout = useSyncExternalStore(subscribeMobileLayout, getMobileLayout, () => false);
  // Widening past the breakpoint hides burger and backdrop, so the drawer must not stay open (inert, focus trap).
  const mobileNavOpen = isSetup && isMobileLayout && navRequested;
  if (!isMobileLayout && navRequested) setMobileNavOpen(false);
  // A route change (e.g. browser Back) closes the drawer instead of leaving stale state behind.
  const [seenMode, setSeenMode] = useState(mode);
  if (seenMode !== mode) {
    setSeenMode(mode);
    setMobileNavOpen(false);
  }
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
    const routeChanged = previousFocusKeyRef.current !== focusKey;
    previousFocusKeyRef.current = focusKey;
    if (!initialRouteFocusHandledRef.current) {
      initialRouteFocusHandledRef.current = true;
      if (!mobileNavOpen) mainRef.current?.focus({ preventScroll: true });
      return;
    }
    if (routeChanged) {
      if (mobileNavOpen || wasMobileNavOpenRef.current) {
        focusMainAfterMobileCloseRef.current = true;
        setReturnFocusOnClose(false);
        if (mobileNavOpen) queueMicrotask(() => setMobileNavOpen(false));
        return;
      }
      mainRef.current?.focus({ preventScroll: true });
      return;
    }
  }, [focusKey, mobileNavOpen]);

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
      if (focusMainAfterMobileCloseRef.current) {
        focusMainAfterMobileCloseRef.current = false;
        mainRef.current?.focus({ preventScroll: true });
      } else if (returnFocusOnClose) {
        mobileBurgerRef.current?.focus({ preventScroll: true });
      }
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
        <main className="dashboard-shell__main" inert={mobileNavOpen} ref={mainRef} tabIndex={-1}>{children}</main>
      </div>
      <ToastHost />
    </div>
  );
}
