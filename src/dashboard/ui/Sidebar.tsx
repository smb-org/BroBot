import { type MouseEvent, type ReactNode, useLayoutEffect, useRef } from "react";

import { StatusLed, type StatusLedState } from "./StatusLed";
import { Icon } from "./Icon";

export interface SidebarEntry {
  id: string;
  pageId?: string;
  category: string;
  label: string;
  icon: ReactNode;
  href: string;
  active: boolean;
  onNavigate: () => void;
  onPreload?: () => void;
  led?: { status: StatusLedState; word: string };
}

export interface SidebarGroup {
  id: string;
  category: string;
  heading: string;
  entries: SidebarEntry[];
}

export interface SidebarProps {
  groups: SidebarGroup[];
  onOpenCommandPalette: () => void;
  onEntryNavigate: () => void;
  setupHeading: string;
  setupDescription: string;
  paletteLabel: string;
  paletteShortcut: string;
}

const stopAndNavigate = (entry: SidebarEntry, onEntryNavigate: () => void) =>
  (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    entry.onNavigate();
    onEntryNavigate();
  };

export function Sidebar({ groups, onOpenCommandPalette, onEntryNavigate, setupHeading, setupDescription, paletteLabel, paletteShortcut }: SidebarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeHref = groups.flatMap((group) => group.entries).find((entry) => entry.active)?.href ?? "";
  const navigationSignature = groups.map((group) => `${group.id}:${group.entries.map((entry) => entry.id).join(",")}`).join("|");

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (scrollArea === null) return;
    const activeEntry = scrollArea.querySelector<HTMLElement>(".sidebar-nav-link[aria-current='page']");
    if (activeEntry === null) return;

    const scrollAreaBounds = scrollArea.getBoundingClientRect();
    const entryBounds = activeEntry.getBoundingClientRect();
    const visibleTop = scrollAreaBounds.top + 8;
    const visibleBottom = scrollAreaBounds.bottom - 8;
    if (entryBounds.top < visibleTop) scrollArea.scrollTop -= visibleTop - entryBounds.top;
    else if (entryBounds.bottom > visibleBottom) scrollArea.scrollTop += entryBounds.bottom - visibleBottom;
  }, [activeHref, navigationSignature]);

  const renderEntry = (entry: SidebarEntry): ReactNode => {
    const accessibleName = entry.led === undefined ? entry.label : `${entry.label} · ${entry.led.word}`;
    return (
      <a
        aria-label={entry.led === undefined ? undefined : accessibleName}
        aria-current={entry.active ? "page" : undefined}
        className={`sidebar-nav-link${entry.active ? " is-active" : ""}`}
        data-category={entry.category}
        data-nav-page-id={entry.pageId}
        href={entry.href}
        key={entry.id}
        onClick={stopAndNavigate(entry, onEntryNavigate)}
        onFocus={entry.onPreload}
        onMouseEnter={entry.onPreload}
        title={entry.led === undefined ? undefined : accessibleName}
      >
        <span aria-hidden="true" className="sidebar-nav-link__icon">{entry.icon}</span>
        <span className="sidebar-nav-link__label">{entry.label}</span>
        {entry.led === undefined ? null : <StatusLed state={entry.led.status} label={entry.led.word} dotOnly />}
      </a>
    );
  };

  return (
    <div className="sidebar" data-ui="">
      <div className="sidebar__main">
        <header className="sidebar__intro">
          <h1 className="sidebar__title">{setupHeading}</h1>
          <p className="sidebar__description">{setupDescription}</p>
        </header>
        <div className="sidebar__scroll" ref={scrollRef}>
          {groups.map((group) => (
            <section aria-labelledby={`sidebar-heading-${group.id}`} className="sidebar__group" data-category={group.category} key={group.id}>
              <h2 className="sidebar__heading" id={`sidebar-heading-${group.id}`}>
                <span aria-hidden="true" className="sidebar__category-marker" />
                <span>{group.heading}</span>
              </h2>
              <div className="sidebar__items">{group.entries.map(renderEntry)}</div>
            </section>
          ))}
        </div>
        <footer className="sidebar__footer">
          <button aria-label={paletteLabel} className="sidebar__palette-trigger" onClick={() => { onEntryNavigate(); onOpenCommandPalette(); }} type="button">
            <Icon name="search" size={16} className="sidebar__palette-icon" />
            <span className="sidebar__palette-label">{paletteLabel}</span>
            <kbd className="sidebar__palette-shortcut">{paletteShortcut}</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
