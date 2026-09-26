import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AuditSentence, Badge, DangerSection, FilterBar, InspectorActions, InspectorFieldRow, InspectorSection, PageHeader } from "../../src/dashboard/ui";

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
      <DangerSection title="Danger zone"><button type="button">Delete</button></DangerSection>
    </>);

    expect(screen.getByRole("heading", { name: "General" })).toHaveClass("inspector-content-section__heading");
    expect(screen.getByRole("button", { name: "Name: Use a short name." })).toHaveAttribute("title", "Use a short name.");
    expect(container.querySelector(".inspector-field-row__control")).toContainElement(screen.getByRole("textbox", { name: "Name" }));
    expect(container.querySelector(".inspector-actions")).toContainElement(screen.getByRole("button", { name: "Save" }));
    expect(container.querySelector(".inspector-content-section--danger")).toContainElement(screen.getByRole("button", { name: "Delete" }));
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
