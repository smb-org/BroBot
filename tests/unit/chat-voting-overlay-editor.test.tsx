import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChatVotingOverlayEditor from "../../src/modules/chat_voting/overlay/editor";

describe("chat voting overlay editor", () => {
  afterEach(cleanup);

  it.each([
    ["en", "Show countdown"],
    ["de", "Countdown anzeigen"],
  ] as const)("shows the countdown option enabled by default in %s", (language, label) => {
    const onChange = vi.fn();
    render(<ChatVotingOverlayEditor config={{}} onChange={onChange} language={language} />);

    const checkbox = screen.getByRole("checkbox", { name: label });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith({ showCountdown: false });
  });

  it("takes colors from the vote by default and saves an explicit opt-out", () => {
    const onChange = vi.fn();
    render(<ChatVotingOverlayEditor config={{}} onChange={onChange} language="en" />);

    const checkbox = screen.getByRole("switch", { name: "Take colours from the voting" });
    expect(checkbox).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Layout" }).parentElement?.parentElement?.style.gap).toBe("var(--s2)");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith({ useVoteColors: false });
  });
});
