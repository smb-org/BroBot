import { type MouseEvent, type ReactNode } from "react";

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

export function Sidebar({ groups, onOpenCommandPalette, onEntryNavigate, paletteLabel, paletteShortcut }: SidebarProps) {
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
        <button aria-label={paletteLabel} className="sidebar__palette-trigger" onClick={() => { onEntryNavigate(); onOpenCommandPalette(); }} type="button">
          <Icon name="search" size={16} className="sidebar__palette-icon" />
          <span className="sidebar__palette-label">{paletteLabel}</span>
          <kbd className="sidebar__palette-shortcut">{paletteShortcut}</kbd>
        </button>
        <div className="sidebar__scroll">
          {groups.map((group) => (
            <section aria-labelledby={`sidebar-heading-${group.id}`} className="sidebar__group" data-category={group.category} key={group.id}>
              <h2 className="sidebar__heading" id={`sidebar-heading-${group.id}`}>
                <span className="sidebar__category-badge">{group.heading}</span>
              </h2>
              <div className="sidebar__items">{group.entries.map(renderEntry)}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
