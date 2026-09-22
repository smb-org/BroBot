import { NavLink } from "@mantine/core";
import { useState, type MouseEvent, type ReactNode } from "react";

import { Led, type LedStatus } from "./Led";

export interface SidebarEntry {
  id: string;
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
  icon: ReactNode;
  label: string;
  /** Whether the current route is inside a module or the module list -- drives auto-expand, not the row's own active style (only a selected child gets that). */
  active: boolean;
  entries: SidebarEntry[];
  allEntry: SidebarEntry;
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
  // Auto-expands the group once the route enters it, without fighting a
  // later manual collapse: adjusted during render (not in an effect) per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [modulesOpened, setModulesOpened] = useState(modules.active);
  const [wasActive, setWasActive] = useState(modules.active);
  if (modules.active !== wasActive) {
    setWasActive(modules.active);
    if (modules.active) setModulesOpened(true);
  }

  const renderEntry = (entry: SidebarEntry): ReactNode => (
    <NavLink
      key={entry.id}
      href={entry.href}
      label={collapsed ? undefined : entry.label}
      title={collapsed ? entry.label : undefined}
      aria-label={collapsed ? entry.label : undefined}
      leftSection={entry.icon}
      rightSection={entry.led === undefined || collapsed ? undefined : <Led status={entry.led.status} word={entry.led.word} />}
      active={entry.active}
      aria-current={entry.active ? "page" : undefined}
      className="sidebar-nav-link"
      onClick={stopAndNavigate(entry.onNavigate, onEntryNavigate)}
    />
  );

  return (
    <div className="sidebar" data-collapsed={collapsed ? "true" : undefined}>
      <div className="sidebar__scroll">
        {groups.map((group) => (
          <div className="sidebar__group" key={group.id}>
            {collapsed ? null : <div className="sidebar__heading">{group.heading}</div>}
            {group.entries.map(renderEntry)}
          </div>
        ))}
        <div className="sidebar__group">
          {collapsed ? null : <div className="sidebar__heading">{modules.heading}</div>}
          <NavLink
            label={collapsed ? undefined : modules.label}
            title={collapsed ? modules.label : undefined}
            aria-label={collapsed ? modules.label : undefined}
            leftSection={modules.icon}
            opened={modulesOpened}
            onChange={setModulesOpened}
            className="sidebar-nav-link sidebar-nav-link--parent"
          >
            {modules.entries.map(renderEntry)}
            {renderEntry(modules.allEntry)}
          </NavLink>
        </div>
      </div>
      {platform === undefined ? null : (
        <div className="sidebar__group sidebar__group--platform">
          {collapsed ? null : <div className="sidebar__heading">{platform.heading}</div>}
          {platform.entries.map(renderEntry)}
        </div>
      )}
      <button
        type="button"
        className="sidebar__collapse-toggle"
        aria-label={collapsed ? expandLabel : collapseLabel}
        onClick={onToggleCollapsed}
      >
        <svg className="sidebar-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {collapsed ? <path d="m10 6 6 6-6 6" /> : <path d="m14 6-6 6 6 6" />}
        </svg>
      </button>
    </div>
  );
}
