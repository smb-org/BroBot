import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DiscordServerStatus } from "../../src/modules/discord/panel/status";

afterEach(cleanup);

describe("Discord server status panel", () => {
  it.each([
    ["not_connected", "No Discord server connected"],
    ["not_available", "Discord server management is not available right now"],
    ["connected", "Discord server connected"],
    ["bot_removed", "BroBot no longer has access to this server"],
    ["permissions_missing", "BroBot needs Manage Roles or Administrator"],
    ["role_too_low", "Move BroBot's highest role above the mapped roles"],
    ["could_not_check", "Could not check Discord right now"],
  ] as const)("shows the stable message for %s", (state, expected) => {
    render(<DiscordServerStatus state={state} language="en" />);
    expect(screen.getByRole("status")).toHaveTextContent(expected);
  });
});
