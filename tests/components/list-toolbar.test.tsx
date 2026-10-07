import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { ListToolbar } from "../../src/dashboard/ui/ListToolbar";

const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");

afterEach(() => {
  cleanup();
  if (initialLanguage !== undefined) Object.defineProperty(window.navigator, "language", initialLanguage);
});

const usageCopy = {
  countSuffix: "commands",
  filteredInfix: "of",
  filteredSuffix: "commands",
  limitInfix: "of",
  limitSuffix: "text blocks used",
  loadedSuffix: "loaded",
};

const hasText = (text: string) => (_content: string, element: Element | null): boolean => element !== null && element.textContent.replace(/\s+/gu, " ").trim() === text;

describe("ListToolbar", () => {
  it("renders a search field, the page filters, the labeled create action, and the reserved status row", () => {
    const onSearchChange = vi.fn();
    const onCreate = vi.fn();
    const onReset = vi.fn();
    const { container } = render(<UiProvider><ListToolbar
      searchLabel="Search commands"
      searchPlaceholder="Search commands"
      searchClearLabel="Clear search"
      searchValue=""
      onSearchChange={onSearchChange}
      filtersLabel="Command filters"
      filters={<button type="button">All commands</button>}
      create={{ label: "Add command", onClick: onCreate, disabled: true, reason: "Only managers may add commands." }}
      usage={{ count: 45, maximum: 50, copy: usageCopy }}
      activeFilters="Name: !discord"
      activeFiltersLabel="Active filters:"
      resetLabel="Reset"
      onReset={onReset}
    /></UiProvider>);

    expect(screen.getByRole("textbox", { name: "Search commands" })).toHaveAttribute("placeholder", "Search commands");
    expect(screen.getByRole("group", { name: "Command filters" })).toHaveTextContent("All commands");
    expect(screen.getByRole("button", { name: "Add command" })).toBeDisabled();
    expect(screen.getByText("Only managers may add commands.")).toBeVisible();
    expect(screen.getByText(hasText("45 of 50 text blocks used"))).toBeVisible();
    expect(container.querySelectorAll(".list-toolbar__usage .mono")).toHaveLength(2);
    expect(container.querySelector(".list-toolbar__usage")).toHaveClass("list-toolbar__usage--warning");
    expect(screen.getByText("Active filters: Name: !discord")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(container.querySelector(".list-toolbar__status")).toBeInTheDocument();
  });

  it("clears immediately from Escape and keeps the clear control mounted when empty", () => {
    const onSearchChange = vi.fn();
    const { container, rerender } = render(<UiProvider><ListToolbar
      searchLabel="Search commands"
      searchPlaceholder="Search commands"
      searchClearLabel="Clear search"
      searchValue=""
      onSearchChange={onSearchChange}
      usage={{ count: 12, copy: usageCopy }}
    /></UiProvider>);

    const clearButton = container.querySelector<HTMLButtonElement>(".ui-field__clear");
    expect(clearButton).not.toBeNull();
    expect(clearButton).toBeDisabled();
    expect(clearButton).toHaveStyle({ visibility: "hidden" });

    rerender(<UiProvider><ListToolbar
      searchLabel="Search commands"
      searchPlaceholder="Search commands"
      searchClearLabel="Clear search"
      searchValue="discord"
      onSearchChange={onSearchChange}
      usage={{ count: 12, copy: usageCopy }}
    /></UiProvider>);

    const search = screen.getByRole("textbox", { name: "Search commands" });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onSearchChange).toHaveBeenCalledWith("");
    const visibleClearButton = container.querySelector<HTMLButtonElement>(".ui-field__clear");
    expect(visibleClearButton).toBeEnabled();
    expect(visibleClearButton).toHaveStyle({ visibility: "visible" });
    fireEvent.click(visibleClearButton as HTMLButtonElement);
    expect(onSearchChange).toHaveBeenLastCalledWith("");
  });

  it("counts active client filters against loaded rows without a server total", () => {
    render(<UiProvider><ListToolbar
      searchLabel="Search commands"
      searchPlaceholder="Search commands"
      searchClearLabel="Clear search"
      searchValue="discord"
      onSearchChange={() => undefined}
      usage={{ count: 12, filteredCount: 3, copy: usageCopy }}
      activeFilters="discord"
      activeFiltersLabel="Active filters:"
      resetLabel="Reset"
      onReset={() => undefined}
    /></UiProvider>);

    expect(screen.getByText(hasText("3 of 12 commands"))).toBeVisible();
  });

  it("formats usage counts with the explicit panel language", () => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "de-DE" });
    render(<UiProvider><ListToolbar
      language="en"
      searchLabel="Search commands"
      searchPlaceholder="Search commands"
      searchClearLabel="Clear search"
      searchValue=""
      onSearchChange={() => undefined}
      usage={{ count: 1234, maximum: 1500, copy: { ...usageCopy, limitSuffix: "text blocks used" } }}
    /></UiProvider>);

    expect(document.querySelector(".list-toolbar__usage")).toHaveTextContent("1,234 of 1,500 text blocks used");
  });
});
