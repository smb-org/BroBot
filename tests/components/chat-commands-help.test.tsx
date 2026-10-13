import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatCommandsHelp } from "../../src/dashboard/ui";
import { CHAT_VOTING_CHAT_COMMANDS } from "../../src/modules/chat_voting/contracts/chat-commands";

afterEach(cleanup);

describe("ChatCommandsHelp", () => {
  it("renders nothing for modules without declared chat commands", () => {
    const { container } = render(<ChatCommandsHelp commands={[]} language="en" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows bilingual help from the module declaration with copy action", () => {
    render(<ChatCommandsHelp commands={CHAT_VOTING_CHAT_COMMANDS} language="en" />);

    fireEvent.click(screen.getByRole("button", { name: "Chat commands · 1" }));
    const help = screen.getByRole("dialog", { name: "Chat commands" });
    expect(help).toHaveTextContent("!vote [type] [question]");
    expect(help).toHaveTextContent("Starts or ends a chat vote.");
    expect(help).toHaveTextContent("Available in chat to: moderators and broadcasters");
    expect(within(help).getByRole("button", { name: "Copy: !vote [type] [question]" })).toBeInTheDocument();
  });
});
