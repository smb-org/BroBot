import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DisabledFieldReasonContext } from "../../src/dashboard/ui/DisabledFieldReason";
import ChatVotingOverlayEditor from "../../src/modules/chat_voting/overlay/editor";
import { clickSelectOption } from "../query-test-utils";

describe("chat voting overlay editor", () => {
  afterEach(cleanup);

  it.each([
    ["en", "Show countdown"],
    ["de", "Countdown anzeigen"],
  ] as const)("shows the countdown option enabled by default in %s", (language, label) => {
    const onChange = vi.fn();
    render(<ChatVotingOverlayEditor config={{}} onChange={onChange} language={language} />);

    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ showCountdown: false });
  });

  it("takes colors from the vote by default and saves an explicit opt-out", () => {
    const onChange = vi.fn();
    render(<ChatVotingOverlayEditor config={{}} onChange={onChange} language="en" />);

    const toggle = screen.getByRole("switch", { name: "Take colours from the voting" });
    expect(toggle).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Layout" }).closest(".ui-select")).not.toBeNull();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ useVoteColors: false });
  });

  it("uses the shared layout select and saves the selected layout", async () => {
    const onChange = vi.fn();
    render(<ChatVotingOverlayEditor config={{}} onChange={onChange} language="en" />);

    const layout = screen.getByRole("combobox", { name: "Layout" });
    expect(layout.closest(".ui-select")).not.toBeNull();
    fireEvent.click(layout);
    clickSelectOption(await screen.findByRole("option", { name: "Strip", hidden: true }));

    expect(onChange).toHaveBeenCalledWith({ layout: "strip" });
  });

  it("renders booleans as switches and clamps the result timeout to whole seconds from zero to 120", () => {
    const onChange = vi.fn();
    render(<ChatVotingOverlayEditor config={{}} onChange={onChange} language="en" />);

    expect(screen.getAllByRole("switch")).toHaveLength(3);
    const seconds = screen.getByRole("spinbutton", { name: "Hide results after (seconds)" });
    expect(seconds).toHaveAttribute("min", "0");
    expect(seconds).toHaveAttribute("max", "120");

    fireEvent.change(seconds, { target: { value: "121.8" } });
    expect(onChange).toHaveBeenLastCalledWith({ hideAfterCloseSeconds: 120 });
    fireEvent.change(seconds, { target: { value: "-1.8" } });
    expect(onChange).toHaveBeenLastCalledWith({ hideAfterCloseSeconds: 0 });
    fireEvent.change(seconds, { target: { value: "19.8" } });
    expect(onChange).toHaveBeenLastCalledWith({ hideAfterCloseSeconds: 19 });
  });

  it("disables every control in read-only mode and describes the lock reason", () => {
    const reason = "Only editors can change this overlay.";
    const onChange = vi.fn();
    render(<DisabledFieldReasonContext.Provider value={{ id: "overlay-editor-readonly-reason", reason }}>
      <p id="overlay-editor-readonly-reason" className="sr-only">{reason}</p>
      <ChatVotingOverlayEditor config={{}} onChange={onChange} language="en" readOnly />
    </DisabledFieldReasonContext.Provider>);

    const controls = [
      screen.getByRole("combobox", { name: "Layout" }),
      screen.getByRole("spinbutton", { name: "Hide results after (seconds)" }),
      ...screen.getAllByRole("switch"),
    ];
    for (const control of controls) expect(control).toBeDisabled();
    for (const toggle of screen.getAllByRole("switch")) expect(toggle).toHaveAccessibleDescription(reason);
    expect(screen.getByRole("combobox", { name: "Layout" })).toHaveAttribute("aria-describedby", "overlay-editor-readonly-reason");
    expect(screen.getByRole("spinbutton", { name: "Hide results after (seconds)" }).getAttribute("aria-describedby")).toContain("overlay-editor-readonly-reason");
    expect(onChange).not.toHaveBeenCalled();
  });
});
