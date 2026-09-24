import { NavLink } from "@mantine/core";
import { type MouseEvent, type ReactNode } from "react";

import { Led, type LedStatus } from "./Led";
import { Icon } from "./Icon";

export interface SidebarEntry {
  id: string;
  /** Page id for rendered navigation entries; module entries leave this unset. */
  pageId?: string;
  label: string;
  icon: ReactNode;
  href: string;
  active: boolean;
  onNavigate: () => void;
  led?: { status: LedStatus; word: string };
}

export interface SidebarGroup {
  id: string;
  heading: string;
  entries: SidebarEntry[];
}

export interface SidebarModulesGroup {
  heading: string;
  entry: SidebarEntry;
  entries: SidebarEntry[];
}

export interface SidebarProps {
  groups: SidebarGroup[];
  modules: SidebarModulesGroup;
  platform?: SidebarGroup | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onEntryNavigate: () => void;
  collapseLabel: string;
  expandLabel: string;
}

const stopAndNavigate = (onNavigate: () => void, onEntryNavigate: () => void) =>
  (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    onNavigate();
    onEntryNavigate();
  };

/**
 * "Seitenleiste" in docs/input/DESIGN-neu.md: four groups, each with a
 * section heading, entries at 44px. This is a plain `<div>`, not a `<nav>`
 * -- the landmark role lives on `Shell`'s `AppShell.Navbar`, one level up;
 * nesting a second `navigation` landmark inside it would be a duplicate
 * landmark, not a second one.
 *
 * Collapsed (80px) shows icon-only entries with a native tooltip instead
 * of the icon-over-label stack the document describes, and the Modules
 * group expands in place rather than opening a popover flyout.
 * ponytail: both are a visual simplification within budget, not a
 * functional gap -- every entry stays reachable and labeled. Upgrade path:
 * a stacked `NavLink` layout and a `Popover` around the Modules group when
 * this needs to look pixel-exact rather than just work.
 */
export function Sidebar({ groups, modules, platform, collapsed, onToggleCollapsed, onEntryNavigate, collapseLabel, expandLabel }: SidebarProps) {
  const renderEntry = (entry: SidebarEntry, moduleChild = false): ReactNode => {
    const accessibleName = moduleChild && entry.led !== undefined
      ? `${entry.label} · ${entry.led.word}`
      : entry.label;
    return (
      <NavLink
        key={entry.id}
        data-nav-page-id={entry.pageId}
        href={entry.href}
        label={collapsed ? undefined : entry.label}
        title={moduleChild || collapsed ? accessibleName : undefined}
        aria-label={moduleChild || collapsed ? accessibleName : undefined}
        leftSection={entry.icon}
        rightSection={entry.led === undefined || collapsed ? undefined : <Led status={entry.led.status} word={entry.led.word} dotOnly={moduleChild} />}
        active={entry.active}
        aria-current={entry.active ? "page" : undefined}
        className={`sidebar-nav-link${moduleChild ? " sidebar-nav-link--module-child" : ""}`}
        onClick={stopAndNavigate(entry.onNavigate, onEntryNavigate)}
      />
    );
  };

  return (
    <div className="sidebar" data-collapsed={collapsed ? "true" : undefined}>
      <div className="sidebar__scroll">
        {groups.map((group) => (
          <div className="sidebar__group" key={group.id}>
            {collapsed ? null : <div className="sidebar__heading">{group.heading}</div>}
          {group.entries.map((entry) => renderEntry(entry))}
          </div>
        ))}
        <div className="sidebar__group">
          {collapsed ? null : <div className="sidebar__heading">{modules.heading}</div>}
          {renderEntry(modules.entry)}
          {modules.entries.map((entry) => renderEntry(entry, true))}
        </div>
      </div>
      {platform === undefined ? null : (
        <div className="sidebar__group sidebar__group--platform">
          {collapsed ? null : <div className="sidebar__heading">{platform.heading}</div>}
          {platform.entries.map((entry) => renderEntry(entry))}
        </div>
      )}
      <button
        type="button"
        className="sidebar__collapse-toggle"
        aria-label={collapsed ? expandLabel : collapseLabel}
        onClick={onToggleCollapsed}
      >
        <Icon name="collapse" size={20} className={collapsed ? "sidebar-nav-icon sidebar-nav-icon--reversed" : "sidebar-nav-icon"} />
      </button>
    </div>
  );
}
