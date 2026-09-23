import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListDetail, SubInspector } from "../../src/dashboard/ui";

const list = <section role="region" aria-label="Liste">Liste</section>;
const inspector = <section role="region" aria-label="Details">Details</section>;

describe("ListDetail", () => {
  afterEach(() => {
    cleanup();
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
});
