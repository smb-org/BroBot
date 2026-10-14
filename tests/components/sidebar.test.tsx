import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../../src/dashboard/styles.css";
import { Sidebar, type SidebarEntry } from "../../src/dashboard/ui";

describe("Sidebar", () => {
  it("keeps category groups and all links in the shared scroll region", () => {
    const entries: SidebarEntry[] = Array.from({ length: 15 }, (_, index) => ({
      id: `module-${String(index + 1)}`,
      category: "chat",
      label: `Module ${String(index + 1)}`,
      icon: <span aria-hidden="true">M</span>,
      href: `/modules/${String(index + 1)}`,
      active: false,
      onNavigate: vi.fn(),
      led: { status: "ok", word: "Running" },
    }));
    const { container } = render(
      <Sidebar
        groups={[{ id: "chat", category: "chat", heading: "Chat", entries }, { id: "admin", category: "admin", heading: "Administration", entries: [{
          id: "manage-modules", category: "admin", label: "Manage modules", icon: <span aria-hidden="true">+</span>, href: "/modules", active: false, onNavigate: vi.fn(),
        }] }]}
        onOpenCommandPalette={vi.fn()}
        onEntryNavigate={vi.fn()}
        setupHeading="Setup"
        setupDescription="Everything for your stream."
        paletteLabel="Search everything"
        paletteShortcut="Ctrl K"
      />,
    );

    const scrollRegion = container.querySelector(".sidebar__scroll");
    expect(scrollRegion).not.toBeNull();
    expect(within(scrollRegion as HTMLElement).getAllByRole("link")).toHaveLength(16);
    expect(within(scrollRegion as HTMLElement).getAllByRole("link", { name: /^Module /u })).toHaveLength(15);
    expect(within(container).getByRole("heading", { name: "Chat", level: 2 })).toBeInTheDocument();
    expect(within(container).getByRole("heading", { name: "Administration", level: 2 })).toBeInTheDocument();
    expect(within(container).queryByText("Running")).toBeNull();
    expect(container.querySelector(".sidebar__group[data-category='chat'] .sidebar__category-marker")).toBeInTheDocument();
    expect((scrollRegion as Node).compareDocumentPosition(container.querySelector(".sidebar__palette-trigger") as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(container).getByRole("heading", { name: "Setup", level: 1 })).toBeInTheDocument();
  });

  it("opens the command palette from its search button", () => {
    const onOpenCommandPalette = vi.fn();
    const onEntryNavigate = vi.fn();
    render(
      <Sidebar groups={[]} onOpenCommandPalette={onOpenCommandPalette} onEntryNavigate={onEntryNavigate} setupHeading="Setup" setupDescription="Everything for your stream." paletteLabel="Search" paletteShortcut="Ctrl K" />,
    );

    screen.getByRole("button", { name: "Search" }).click();
    expect(onEntryNavigate).toHaveBeenCalledOnce();
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
  });
});
