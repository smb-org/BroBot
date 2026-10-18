import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoiceCards } from "../../src/dashboard/ui/ChoiceCards";
import { FieldError } from "../../src/dashboard/ui";
import { LockedReason } from "../../src/dashboard/ui/LockedReason";
import { RoleThreshold } from "../../src/dashboard/ui/RoleThreshold";
import { RuleNote } from "../../src/dashboard/ui/RuleNote";
import { Section } from "../../src/dashboard/ui/Section";
import { SwitchRow } from "../../src/dashboard/ui/SwitchRow";
import { SwitchSection } from "../../src/dashboard/ui/SwitchSection";

afterEach(cleanup);

describe("Part A dashboard kit", () => {
  it("renders Section with a named heading and content", () => {
    render(<Section title="Message settings"><p>Saved settings.</p></Section>);

    expect(screen.getByRole("heading", { level: 2, name: "Message settings" })).toBeInTheDocument();
    expect(screen.getByText("Saved settings.")).toBeInTheDocument();
  });

  it("keeps SwitchRow named, keyboard-focusable, and visibly locked with a reason", () => {
    render(<SwitchRow label="Enabled" description="Changes are saved with the form." checked={false} onChange={vi.fn()} lockedReason="Only managers may change this." />);
    const toggle = screen.getByRole("switch", { name: "Enabled" });
    const reason = screen.getByRole("note");

    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("tabindex", "0");
    expect(toggle).toBeDisabled();
    expect(reason).toHaveTextContent("Only managers may change this.");
    expect(toggle.getAttribute("aria-describedby")).toContain(reason.id);
  });

  it("keeps SwitchSection off to one title row and one hint, then mounts children when on", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<SwitchSection title="Post clip link" hint="The clip link stays in the history." checked={false} onChange={onChange}>
      <label>Chat message<input aria-label="Chat message" /></label>
    </SwitchSection>);
    const section = container.querySelector(".ui-switch-section");

    expect(section?.children).toHaveLength(2);
    expect(section?.firstElementChild).toHaveClass("ui-switch-section__heading");
    expect(section?.lastElementChild).toHaveClass("ui-switch-section__hint");
    expect(screen.queryByRole("textbox", { name: "Chat message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Post clip link" }));
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<SwitchSection title="Post clip link" hint="The clip link stays in the history." checked onChange={onChange}>
      <label>Chat message<input aria-label="Chat message" /></label>
    </SwitchSection>);
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(section?.children.item(1)).toHaveClass("ui-switch-section__content");
  });

  it("shows the selected RoleThreshold inclusion and keeps a denied selection visible, disabled, and explained", () => {
    const options = [
      { value: "everyone", label: "Everyone", inclusion: "Viewers, subscribers, VIPs, moderators, and broadcasters." },
      { value: "subscriber", label: "Subscriber", inclusion: "Subscribers, moderators, and broadcasters. VIPs without a subscription are excluded." },
    ] as const;
    const { rerender } = render(<RoleThreshold label="Minimum role" value="subscriber" onChange={vi.fn()} options={options} />);
    const select = screen.getByRole("combobox", { name: "Minimum role" });

    expect(select).toHaveAccessibleDescription(options[1].inclusion);
    rerender(<RoleThreshold label="Minimum role" value="subscriber" onChange={vi.fn()} options={options} disabled lockedReason="Only managers may change this." />);
    expect(screen.getByRole("combobox", { name: "Minimum role" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("Only managers may change this.");
    expect(screen.getByText(options[1].inclusion)).toBeInTheDocument();
  });

  it("supports named keyboard-focusable ChoiceCards and updates the pressed option", () => {
    function Harness() {
      const [value, setValue] = useState("text");
      return <ChoiceCards label="Response" value={value} onChange={setValue} options={[
        { value: "text", label: "Text", description: "Write a chat message." },
        { value: "block", label: "Block", description: "Use a saved text block." },
      ]} />;
    }
    render(<Harness />);
    const text = screen.getByRole("button", { name: "Text. Write a chat message." });
    const block = screen.getByRole("button", { name: "Block. Use a saved text block." });

    expect(text).toHaveAttribute("aria-pressed", "true");
    expect(text).toHaveAttribute("tabindex", "0");
    block.focus();
    fireEvent.click(block);
    expect(block).toHaveAttribute("aria-pressed", "true");
    expect(text).toHaveAttribute("aria-pressed", "false");
  });

  it("renders the ChoiceCards check icon only for the selected card", () => {
    const { container } = render(<ChoiceCards label="Response" value="text" onChange={vi.fn()} options={[
      { value: "text", label: "Text", description: "Write a chat message." },
      { value: "block", label: "Block", description: "Use a saved text block." },
    ]} />);
    const slots = container.querySelectorAll(".ui-choice-card__check");

    expect(slots).toHaveLength(2);
    expect(slots[0]?.querySelector("svg")).not.toBeNull();
    expect(slots[1]?.querySelector("svg")).toBeNull();
  });

  it("caps the module-row lock reason width", () => {
    const css = readFileSync(resolve(process.cwd(), "src/dashboard/ui/core.css"), "utf8");

    expect(css).toMatch(/\.module-switch-control \.ui-locked-reason\s*\{[^}]*max-width:\s*16rem/u);
  });

  it("reserves the FieldError row and announces a message without replacing the slot", () => {
    const { container, rerender } = render(<FieldError />);
    const slot = container.querySelector(".ui-field-error");

    expect(slot).toHaveAttribute("aria-live", "polite");
    expect(slot?.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    rerender(<FieldError message="Choose a valid value." />);

    expect(container.querySelector(".ui-field-error")).toBe(slot);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a valid value.");
  });

  it("reserves the LockedReason row when open and gives locked controls a visible note", () => {
    const { container, rerender } = render(<LockedReason />);
    const slot = container.querySelector(".ui-locked-reason");

    expect(slot).toHaveAttribute("aria-hidden", "true");
    rerender(<LockedReason reason="Only managers may edit this." />);

    expect(container.querySelector(".ui-locked-reason")).toBe(slot);
    expect(screen.getByRole("note")).toHaveTextContent("Only managers may edit this.");
  });

  it("renders RuleNote as a neutral accessible note", () => {
    const { container } = render(<RuleNote>Subscribers do not include VIPs without a subscription.</RuleNote>);

    expect(screen.getByRole("note")).toHaveTextContent("Subscribers do not include VIPs without a subscription.");
    expect(container.querySelector(".ui-rule-note svg")).toHaveAttribute("aria-hidden", "true");
  });
});
