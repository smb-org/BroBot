import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AuditSentence, Badge, FilterBar, InspectorActions, InspectorFieldRow, InspectorSection, PageHeader } from "../../src/dashboard/ui";

afterEach(cleanup);

describe("shared dashboard consistency components", () => {
  it("renders the common page header with its icon tile, subtitle, and right action", () => {
    const { container } = render(<PageHeader kind="audit" title="Audit log" subtitle="12 entries" actions={<button type="button">Export</button>} />);

    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeInTheDocument();
    expect(screen.getByText("12 entries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" }).parentElement).toHaveClass("page-header__actions");
    expect(container.querySelector(".page-header__icon svg")).toBeInTheDocument();
  });

  it("keeps filter controls on one labeled row and active-filter summary below it", () => {
    const { container } = render(<FilterBar label="Event filters" summary={<button type="button">Reset filters</button>}>
      <button type="button">All events</button>
      <select aria-label="Module"><option>All modules</option></select>
      <input aria-label="Person" />
    </FilterBar>);
    const controls = screen.getByRole("group", { name: "Event filters" });

    expect(within(controls).getByRole("button", { name: "All events" })).toBeInTheDocument();
    expect(within(controls).getByRole("combobox", { name: "Module" })).toBeInTheDocument();
    expect(within(controls).getByRole("textbox", { name: "Person" })).toBeInTheDocument();
    expect(within(controls).queryByRole("button", { name: "Reset filters" })).not.toBeInTheDocument();
    expect(container.querySelector(".dashboard-filter-bar__summary")).toContainElement(screen.getByRole("button", { name: "Reset filters" }));
  });

  it("groups inspector sections, field help, pinned actions, and danger controls into their shared parts", () => {
    const { container } = render(<>
      <InspectorSection title="General">
        <InspectorFieldRow label="Name" help="Use a short name."><input aria-label="Name" /></InspectorFieldRow>
      </InspectorSection>
      <InspectorActions><button type="button">Save</button><button type="button">Discard</button></InspectorActions>
      <InspectorActions destructive={<button type="button">Delete</button>}><button type="button">Save</button></InspectorActions>
    </>);

    expect(screen.getByRole("heading", { name: "General" })).toHaveClass("inspector-content-section__heading");
    expect(screen.getByRole("button", { name: "Name: Use a short name." })).toHaveAttribute("title", "Use a short name.");
    expect(container.querySelector(".inspector-field-row__control")).toContainElement(screen.getByRole("textbox", { name: "Name" }));
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    const firstSaveButton = saveButtons.at(0);
    if (firstSaveButton === undefined) throw new Error("The primary inspector Save button is missing.");
    expect(container.querySelector(".inspector-actions")).toContainElement(firstSaveButton);
    expect(container.querySelector(".inspector-content-section--danger")).toBeNull();
    expect(container.querySelector(".inspector-actions__destructive")).toContainElement(screen.getByRole("button", { name: "Delete" }));
  });

  it("opens inspector help on keyboard focus and activation, and dismisses it with Escape", () => {
    render(<InspectorFieldRow label="Name" help="Use a short name."><input aria-label="Name" /></InspectorFieldRow>);
    const info = screen.getByRole("button", { name: "Name: Use a short name." });
    fireEvent.focus(info);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Use a short name.");
    expect(info).toHaveAttribute("aria-describedby", tooltip.id);
    expect(info).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(info, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(info).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(info);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("renders badge and audit sentence chips with a localized from-to transition", () => {
    const { container } = render(<>
      <Badge tone="brand">Manager</Badge>
      <AuditSentence who="Ada Example" action="changed" what="minimum tier" fromLabel="from" from="Everyone" to="Moderators" />
    </>);
    const sentence = container.querySelector(".audit-sentence");

    expect(screen.getByText("Manager")).toHaveClass("ui-badge", "ui-badge--brand");
    expect(sentence).toHaveTextContent("Ada Examplechangedminimum tierfromEveryone→Moderators");
    expect(sentence?.querySelectorAll(".audit-sentence__chip--value")).toHaveLength(2);
    expect(sentence?.querySelector(".audit-sentence__arrow")).toHaveTextContent("→");
  });
});
