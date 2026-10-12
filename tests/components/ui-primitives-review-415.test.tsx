import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChipsInput } from "../../src/dashboard/ui/ChipsInput";
import { Field } from "../../src/dashboard/ui/Field";
import { Select } from "../../src/dashboard/ui/Select";

const chipMessages = {
  countLabel: (count: number, max: number) => `${String(count)} / ${String(max)}`,
  atLimitHint: "Maximum reached",
  duplicateWarning: (entry: string) => `${entry} already exists`,
};

describe("issue 415 primitive regressions", () => {
  afterEach(cleanup);

  it("keeps searchable Select items aligned with filtered keyboard results", async () => {
    const onChange = vi.fn();
    render(<Select label="Timezone" value="utc" onChange={onChange} searchable placeholder="No matches" options={[
      { value: "utc", label: "UTC" },
      { value: "paris", label: "Paris", group: "Europe" },
      { value: "tokyo", label: "Tokyo", group: "Asia" },
    ]} />);

    const input = screen.getByRole("combobox", { name: "Timezone" });
    fireEvent.change(input, { target: { value: "Paris" } });
    expect(await screen.findByRole("option", { name: "Paris", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "UTC", hidden: true })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("paris"));
  });

  it("commits the current chip draft when the input blurs", () => {
    const onChange = vi.fn();
    render(<ChipsInput id="aliases" label="Aliases" values={[]} onChange={onChange} removeLabel={(entry) => `Remove ${entry}`} messages={chipMessages} listLabel="Aliases" />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "draftAlias" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(["draftAlias"]);
  });

  it("gives toolbar search fields an accessible name while hiding their label visually", () => {
    render(<Field variant="search" label="Members" value="" onChange={vi.fn()} clearLabel="Clear search" />);

    expect(screen.getByRole("textbox", { name: "Members" })).toBeInTheDocument();
    expect(document.querySelector(".ui-field__label.sr-only")).toHaveTextContent("Members");
  });

  it("adds input padding when an icon adornment is present", () => {
    render(<Field label="Person" value="" onChange={vi.fn()} icon="member" />);

    const input = screen.getByLabelText("Person");
    expect(input).toHaveClass("ui-field__input--with-leading");
    expect(input.parentElement?.querySelector(".ui-field__leading svg")).toBeInTheDocument();
  });

  it("keeps the Select error row mounted across valid and invalid states", () => {
    const { container, rerender } = render(<Select label="Timezone" value="utc" onChange={vi.fn()} options={[{ value: "utc", label: "UTC" }]} />);
    const errorSlot = container.querySelector(".ui-select__error");

    expect(errorSlot).toHaveAttribute("aria-live", "polite");
    rerender(<Select label="Timezone" value="utc" onChange={vi.fn()} error="Choose a timezone" options={[{ value: "utc", label: "UTC" }]} />);

    expect(container.querySelector(".ui-select__error")).toBe(errorSlot);
    expect(errorSlot).toHaveTextContent("Choose a timezone");
  });
});
