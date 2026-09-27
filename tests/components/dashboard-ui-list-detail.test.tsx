import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListDetail, SubInspector } from "../../src/dashboard/ui";

const list = <section role="region" aria-label="Liste">Liste</section>;
const inspector = <section role="region" aria-label="Details">Details</section>;
const initialWidth = window.innerWidth;

describe("ListDetail", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWidth });
  });

  it("renders only the list when there is no selection -- no waiting dock", () => {
    const { container } = render(<ListDetail list={list} inspector={null} onCloseInspector={() => {}} />);

    expect(screen.getByRole("region", { name: "Liste" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Details" })).not.toBeInTheDocument();
    expect(container.querySelector(".list-detail")).not.toHaveClass("list-detail--open");
    expect(container.querySelector(".list-detail__backdrop")).not.toBeInTheDocument();
  });

  it("shows an identifier only as the inspector title tooltip", () => {
    render(<SubInspector ariaLabel="Details" title="Operation" identifier="internal-id" closeLabel="Close" onClose={() => {}}>Content</SubInspector>);

    const details = screen.getByRole("region", { name: "Details" });
    const title = screen.getByRole("heading", { name: "Operation" });
    expect(title).toHaveAttribute("title", "internal-id");
    expect(details).not.toHaveTextContent("internal-id");
    expect(within(details).queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("renders the list and the inspector together once there is a selection", () => {
    const { container } = render(<ListDetail list={list} inspector={inspector} onCloseInspector={() => {}} />);

    expect(screen.getByRole("region", { name: "Liste" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Details" })).toBeInTheDocument();
    expect(container.querySelector(".list-detail")).toHaveClass("list-detail--open");
    // Both live in the same DOM tree -- styles.css, not React, decides
    // whether the inspector sits beside the list (>=1024px) or floats over
    // it (<1024px); see ListDetail's own doc comment.
    expect(container.querySelector(".list-detail__inspector")).toContainElement(screen.getByRole("region", { name: "Details" }));
  });

  it("closes through the floating backdrop", () => {
    const onCloseInspector = vi.fn();
    const { container } = render(<ListDetail list={list} inspector={inspector} onCloseInspector={onCloseInspector} />);

    const backdrop = container.querySelector(".list-detail__backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);

    expect(onCloseInspector).toHaveBeenCalledOnce();
  });

  it("drops the inspector and its backdrop again once the selection clears -- counter-probes the open state above", () => {
    const { container, rerender } = render(<ListDetail list={list} inspector={inspector} onCloseInspector={() => {}} />);
    expect(container.querySelector(".list-detail")).toHaveClass("list-detail--open");

    rerender(<ListDetail list={list} inspector={null} onCloseInspector={() => {}} />);

    expect(container.querySelector(".list-detail")).not.toHaveClass("list-detail--open");
    expect(container.querySelector(".list-detail__backdrop")).not.toBeInTheDocument();
    expect(container.querySelector(".list-detail__inspector")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Details" })).not.toBeInTheDocument();
  });

  it("treats the narrow inspector as a modal, traps focus, and restores it to the opened row", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    function InteractiveListDetail() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button">Page header action</button>
        <ListDetail
          list={<section><button type="button" onClick={() => setOpen(true)}>Open row</button><button type="button">Background action</button></section>}
          inspector={open ? <SubInspector ariaLabel="Details" title="Selected row" closeLabel="Close" onClose={() => setOpen(false)}><button type="button">Inspector action</button></SubInspector> : null}
          onCloseInspector={() => setOpen(false)}
        />
      </>;
    }
    render(<InteractiveListDetail />);
    const row = screen.getByRole("button", { name: "Open row" });
    row.focus();
    fireEvent.click(row);

    const dialog = screen.getByRole("dialog", { name: "Details" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    const action = within(dialog).getByRole("button", { name: "Inspector action" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(row.closest(".list-detail__list")).toHaveAttribute("inert");
    expect(screen.getByText("Page header action").closest("button")).toHaveProperty("inert", true);
    expect(document.activeElement).toBe(close);

    action.focus();
    fireEvent.keyDown(action, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(action);

    fireEvent.keyDown(action, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Details" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(row);
    expect(screen.getByText("Page header action").closest("button")).not.toHaveAttribute("inert");
  });
});
