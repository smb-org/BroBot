import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionMenu } from "../../src/dashboard/ui/ActionMenu";
import { ChipsInput } from "../../src/dashboard/ui/ChipsInput";
import { CodeField } from "../../src/dashboard/ui/CodeField";
import { DisabledFieldReasonContext } from "../../src/dashboard/ui/DisabledFieldReason";
import { SegmentChoice } from "../../src/dashboard/ui/SegmentChoice";
import { Select } from "../../src/dashboard/ui/Select";
import { StatusLed } from "../../src/dashboard/ui/StatusLed";
import { Switch } from "../../src/dashboard/ui/Switch";
import { UnitInput } from "../../src/dashboard/ui/UnitInput";
import { UiProvider } from "../../src/dashboard/ui/Provider";

afterEach(cleanup);

const renderUi = (node: ReactNode) => render(<UiProvider>{node}</UiProvider>);

describe("basic UI controls", () => {
  it("does not let native step validation reject values anchored away from min", () => {
    const onSubmit = vi.fn((event: SyntheticEvent) => { event.preventDefault(); });
    renderUi(<form aria-label="f" onSubmit={onSubmit}><UnitInput label="Bitrate" value={1000} onChange={() => {}} min={1} step={100} /><button type="submit">Save</button></form>);
    const input = screen.getByLabelText<HTMLInputElement>("Bitrate");
    expect(input.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows the selected option label in a non-searchable select", () => {
    renderUi(<Select
      label="Time zone"
      value="Europe/Berlin"
      onChange={() => {}}
      options={[
        { value: "Europe/Berlin", label: "Berlin, Germany" },
        { value: "Europe/Paris", label: "Paris, France" },
      ]}
    />);

    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveTextContent("Berlin, Germany");
  });

  it("clamps a unit value on blur and applies a suggested value", () => {
    function Harness() {
      const [value, setValue] = useState<number | "">(5);
      return <UnitInput label="Duration" unit="s" value={value} onChange={setValue} min={0} max={10} suggestions={[3, 8]} />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("spinbutton", { name: "Duration" });
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.blur(input);
    expect(input).toHaveValue(10);

    fireEvent.click(screen.getByRole("button", { name: "8 s" }));
    expect(input).toHaveValue(8);
    expect(input.closest(".unit-input__control")).toHaveTextContent("s");
  });

  it("marks the selected segment and changes it by click and arrow keys", () => {
    function Harness() {
      const [value, setValue] = useState("first");
      return <SegmentChoice label="Layout" value={value} onChange={setValue} options={[
        { value: "first", label: "First" },
        { value: "second", label: "Second" },
        { value: "third", label: "Third" },
      ]} />;
    }

    renderUi(<Harness />);
    const first = screen.getByRole("button", { name: "First" });
    expect(first).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Third" }));
    expect(screen.getByRole("button", { name: "Third" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(screen.getByRole("button", { name: "Third" }), { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Second" })).toHaveAttribute("aria-pressed", "true");
  });

  it("adds chips on Enter and comma, strips a leading prefix, and removes the last chip on Backspace", () => {
    function Harness() {
      const [values, setValues] = useState<string[]>([]);
      return <ChipsInput
        label="Aliases"
        listLabel="Alias list"
        values={values}
        onChange={setValues}
        stripPrefix="!"
        max={2}
        removeLabel={(value) => `Remove ${value}`}
        messages={{
          countLabel: (count, max) => `${String(count)}/${String(max)}`,
          atLimitHint: "At the limit.",
          duplicateWarning: (value) => `${value} is already listed.`,
        }}
      />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Aliases" });
    fireEvent.change(input, { target: { value: "!first" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("first")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.keyDown(input, { key: "," });
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(input).toHaveAttribute("readonly");
    expect(input).not.toBeDisabled();

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByText("second")).not.toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(input).not.toHaveAttribute("readonly");
  });

  it("toggles a card switch only once when its label is clicked", () => {
    const changes: boolean[] = [];
    renderUi(<Switch layout="card" label="Card switch" checked={false} onChange={(checked) => { changes.push(checked); }} />);

    fireEvent.click(screen.getByText("Card switch"));

    expect(changes).toEqual([true]);
  });

  it("gives CodeField one unique description ID inside a disabled-reason context", () => {
    renderUi(<DisabledFieldReasonContext.Provider value={{ id: "module-disabled", reason: "Enable the module first." }}>
      <CodeField id="source-code" label="Source code" value="" onChange={() => {}} maxLength={100} />
    </DisabledFieldReasonContext.Provider>);
    const field = screen.getByRole("textbox", { name: "Source code" });
    const describedBy = field.getAttribute("aria-describedby");

    expect(describedBy).not.toBeNull();
    expect(Array.from(document.querySelectorAll("[id]")).filter((element) => element.id === describedBy)).toHaveLength(1);
  });

  it("shows the label for every status state", () => {
    const states = ["ok", "loading", "warn", "error", "off"] as const;
    renderUi(<div>{states.map((state) => <StatusLed key={state} state={state} label={`${state} status`} />)}</div>);
    for (const state of states) expect(screen.getByText(`${state} status`)).toBeVisible();
  });

  it("closes ActionMenu with Escape and returns focus to the trigger", async () => {
    renderUi(<ActionMenu label="More actions" items={[{ label: "Edit settings", onSelect: () => {} }]} />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    trigger.focus();
    fireEvent.click(trigger);

    const item = await screen.findByRole("menuitem", { name: "Edit settings" });
    fireEvent.keyDown(item, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Edit settings" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
