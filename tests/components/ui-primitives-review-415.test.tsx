import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChipsInput } from "../../src/dashboard/ui/ChipsInput";
import { Dialog } from "../../src/dashboard/ui/Dialog";
import { Field } from "../../src/dashboard/ui/Field";
import { Popover } from "../../src/dashboard/ui/Popover";
import { Select } from "../../src/dashboard/ui/Select";
import { SwitchRow } from "../../src/dashboard/ui/SwitchRow";

const chipMessages = {
  countLabel: (count: number, max: number) => `${String(count)} / ${String(max)}`,
  atLimitHint: "Maximum reached",
  duplicateWarning: (entry: string) => `${entry} already exists`,
};

function StatefulAliasInput({ onChange }: { onChange: (values: string[]) => void }) {
  const [values, setValues] = useState<string[]>([]);
  return <ChipsInput
    id="aliases"
    label="Aliases"
    values={values}
    onChange={(next) => { setValues(next); onChange(next); }}
    validate={(entry) => /^[a-z][a-z0-9_]*$/u.test(entry) ? null : "Invalid alias"}
    removeLabel={(entry) => `Remove ${entry}`}
    messages={chipMessages}
    listLabel="Aliases"
  />;
}

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
    const onPendingChange = vi.fn();
    render(<ChipsInput id="aliases" label="Aliases" values={[]} onChange={onChange} onPendingChange={onPendingChange} removeLabel={(entry) => `Remove ${entry}`} messages={chipMessages} listLabel="Aliases" />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "draftAlias" } });
    expect(onPendingChange).toHaveBeenLastCalledWith("draftAlias");
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(["draftAlias"]);
    expect(onPendingChange).toHaveBeenLastCalledWith("");
  });

  it("splits space-delimited aliases typed into the field before validating each alias", () => {
    const onChange = vi.fn();
    render(<StatefulAliasInput onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: "Aliases" });
    fireEvent.change(input, { target: { value: "foo bar" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith(["foo", "bar"]);
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
    expect(screen.queryByText("Invalid alias")).not.toBeInTheDocument();
  });

  it("splits comma-delimited aliases pasted into the field before validating each alias", () => {
    const onChange = vi.fn();
    render(<StatefulAliasInput onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: "Aliases" });
    fireEvent.paste(input, { clipboardData: { getData: () => "foo, bar" } });

    expect(onChange).toHaveBeenLastCalledWith(["foo", "bar"]);
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
    expect(screen.queryByText("Invalid alias")).not.toBeInTheDocument();
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

  it("sizes a text prefix to its content instead of reserving a fixed icon slot", () => {
    const { container } = render(<Field label="Command" prefix="!vote" value="hello" onChange={vi.fn()} />);

    expect(container.querySelector(".ui-field__leading--prefix .ui-field__prefix")).toHaveTextContent("!vote");
    expect(screen.getByLabelText("Command")).toHaveClass("ui-field__input--with-prefix");
  });

  it("provides an accessible header close button that dismisses a dialog", () => {
    const onClose = vi.fn();
    render(<Dialog opened title="Preview" onClose={onClose}><p>Preview content</p></Dialog>);

    fireEvent.click(screen.getByRole("button", { name: /^(Close|Schließen)$/u }));

    expect(onClose).toHaveBeenCalledOnce();
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

describe("issue 415 fieldset and hover-focus regressions", () => {
  afterEach(cleanup);

  it("does not toggle a SwitchRow inside a disabled fieldset", () => {
    const onChange = vi.fn();
    render(<fieldset disabled><SwitchRow label="Chat messages" checked={false} onChange={onChange} /></fieldset>);
    const control = screen.getByRole("switch", { name: "Chat messages" });
    expect(control).toBeDisabled();
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles a SwitchRow once per control click and ignores disabled ones", () => {
    const onChange = vi.fn();
    const { unmount } = render(<SwitchRow label="Chat messages" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Chat messages" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    unmount();

    const disabledChange = vi.fn();
    render(<>
      <SwitchRow label="Direct disabled" checked={false} disabled onChange={disabledChange} />
      <fieldset disabled><SwitchRow label="Fieldset disabled" checked={false} onChange={disabledChange} /></fieldset>
    </>);
    fireEvent.click(screen.getByRole("switch", { name: "Direct disabled" }));
    fireEvent.click(screen.getByRole("switch", { name: "Fieldset disabled" }));
    expect(disabledChange).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus when a Popover opens on hover", async () => {
    render(<><input aria-label="Person" /><Popover triggerLabel="Cause" icon="cause">Details</Popover></>);
    const input = screen.getByLabelText("Person");
    input.focus();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Cause" }));
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(input).toHaveFocus();
  });
});
