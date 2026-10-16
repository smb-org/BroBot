import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatPreview } from "../../src/dashboard/ui/ChatPreview";

afterEach(cleanup);

describe("disabled chat message previews", () => {
  it.each([
    ["de", "Nachricht ausgeschaltet"],
    ["en", "Message is off"],
  ])("renders the %s placeholder without a bot speaker", (_language, emptyText) => {
    render(<ChatPreview
      label="Preview"
      speaker="Bot"
      text=""
      emptyText={emptyText}
      countLabel="0 characters"
    />);

    const placeholder = screen.getByText(emptyText);
    const message = placeholder.closest(".ui-chat-preview__message");
    expect(message).not.toBeNull();
    expect(message).not.toHaveTextContent("Bot:");
    expect(placeholder).toHaveClass("ui-chat-preview__text--empty");
    expect(message).toHaveAttribute("title", emptyText);
  });
});
