import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../../src/dashboard/styles.css";
import { Sidebar, UiProvider, type SidebarEntry } from "../../src/dashboard/ui";

describe("Sidebar", () => {
  it("keeps 15 module links in one scroll region and the collapse control reachable outside it", () => {
    const entries: SidebarEntry[] = Array.from({ length: 15 }, (_, index) => ({
      id: `module-${String(index + 1)}`,
      label: `Module ${String(index + 1)}`,
      icon: <span aria-hidden="true">M</span>,
      href: `/modules/${String(index + 1)}`,
      active: false,
      onNavigate: vi.fn(),
      led: { status: "green", word: "Running" },
    }));
    const { container } = render(
      <UiProvider><Sidebar
        groups={[{ id: "chat", heading: "Chat", entries, nestedEntries: true }, { id: "manage", entries: [{
          id: "manage-modules", label: "Manage modules", icon: <span aria-hidden="true">+</span>, href: "/modules", active: false, onNavigate: vi.fn(),
        }] }]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onEntryNavigate={vi.fn()}
        collapseLabel="Collapse sidebar"
        expandLabel="Expand sidebar"
        spotlightLabel="Search or run an action …"
      /></UiProvider>,
    );

    const scrollRegion = container.querySelector(".sidebar__scroll");
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion).toHaveClass("sidebar__scroll");
    expect(within(scrollRegion as HTMLElement).getAllByRole("link")).toHaveLength(16);
    expect(within(scrollRegion as HTMLElement).getAllByRole("link", { name: /^Module /u })).toHaveLength(15);
    expect(within(container).getByRole("heading", { name: "Chat", level: 2 })).toBeInTheDocument();
    expect(within(container).getByRole("group", { name: "Chat" })).toContainElement(within(scrollRegion as HTMLElement).getByRole("link", { name: "Module 1 · Running" }));

    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle.parentElement).toBe(container.querySelector(".sidebar"));
    expect(scrollRegion?.contains(toggle)).toBe(false);
  });
});
