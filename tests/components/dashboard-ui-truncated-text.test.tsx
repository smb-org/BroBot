import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Field, Select, UiProvider } from "../../src/dashboard/ui";

afterEach(cleanup);

describe("truncated field copy", () => {
  it("keeps full hint and error text in the field's accessible descriptions", () => {
    const hint = "A complete hint that remains available when its reserved line is too short to show every word.";
    const error = "A complete error that remains available when its reserved line is too short to show every word.";
    render(<UiProvider><>
      <Field id="long-copy" label="Name" hint={hint} value="hello" error={error} onChange={() => {}} />
      <Select id="long-select" label="Mode" value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} hint={hint} error={error} />
    </></UiProvider>);

    const input = screen.getByRole("textbox", { name: "Name" });
    const describedIds = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    const description = document.getElementById("long-copy-description");
    const errorDescription = document.getElementById("long-copy-error");

    expect(describedIds).toContain("long-copy-description");
    expect(describedIds).toContain("long-copy-error");
    expect(description?.querySelector(".ui-truncated-text")).toHaveAttribute("title", hint);
    expect(description?.querySelector(".sr-only")).toHaveTextContent(hint);
    expect(errorDescription?.querySelector(".ui-truncated-text")).toHaveAttribute("title", error);
    expect(errorDescription?.querySelector(".sr-only")).toHaveTextContent(error);
    expect(description?.querySelector(".ui-truncated-text")).toHaveAttribute("aria-hidden", "true");

    const select = screen.getByRole("combobox", { name: "Mode" });
    const selectDescribedIds = select.getAttribute("aria-describedby")?.split(/\s+/u).filter(Boolean) ?? [];
    expect(selectDescribedIds).toContain("long-select-description");
    expect(selectDescribedIds).toContain("long-select-error");
    expect(document.getElementById("long-select-description")?.querySelector(".sr-only")).toHaveTextContent(hint);
    expect(document.getElementById("long-select-error")?.querySelector(".sr-only")).toHaveTextContent(error);
  });

  it("omits reserved description and error rows only in compact Select mode", () => {
    const { container } = render(<UiProvider><div>
      <Select id="header-channel" compact ariaLabel="Channel" value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} hint="Header hint" error="Header error" />
      <Select id="form-channel" label="Channel" value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} hint="Form hint" error="Form error" />
    </div></UiProvider>);

    const compact = container.querySelector("#header-channel")?.closest(".ui-select");
    expect(compact).toHaveClass("ui-select--compact");
    expect(compact?.querySelector(".mantine-InputWrapper-description")).not.toBeInTheDocument();
    expect(compact?.querySelector(".mantine-InputWrapper-error")).not.toBeInTheDocument();
    expect(container.querySelector("#form-channel")?.closest(".ui-select")).toHaveTextContent("Form hint");
    expect(container.querySelector("#form-channel")?.closest(".ui-select")).toHaveTextContent("Form error");
  });

  it("renders grouped Select options with their one-line descriptions", () => {
    render(<UiProvider><Select
      label="Vote type"
      value="one"
      onChange={() => {}}
      options={[
        { value: "one", label: "One", group: "Two options", description: "Chat types 1 or 2" },
        { value: "zero", label: "Zero / One", group: "Two options", description: "Chat types 0 or 1" },
        { value: "text", label: "Free text", group: "Text", description: "Chat types a word" },
      ]}
    /></UiProvider>);

    const combobox = screen.getByRole("combobox", { name: "Vote type" });
    fireEvent.click(combobox);
    const listboxId = combobox.getAttribute("aria-controls");
    const listbox = listboxId === null ? null : document.getElementById(listboxId);
    expect(listbox).not.toBeNull();
    if (listbox === null) throw new Error("The type listbox has not mounted.");
    expect(listbox).toHaveTextContent("Two options");
    expect(listbox).toHaveTextContent("OneChat types 1 or 2");
    expect(listbox).toHaveTextContent("Zero / OneChat types 0 or 1");
    expect(listbox).toHaveTextContent("Text");
    expect(listbox).toHaveTextContent("Free textChat types a word");
  });
});
