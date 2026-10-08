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
});
