import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DiscordLinkView, type DiscordLinkPageState } from "../../src/modules/discord/public-page";

const linkedState: DiscordLinkPageState = {
  kind: "linked",
  link: { discordUsername: "nightowl", twitchLogin: "nightowl_dev", linkedAt: "2026-11-24T10:00:00.000Z" },
  channels: [{ channelId: "fictional-channel", displayName: "Harbor Radio", status: "has_role" }],
};

const cases: readonly { name: string; state: DiscordLinkPageState; de: string; en: string }[] = [
  { name: "not configured", state: { kind: "not_configured" }, de: "Derzeit nicht verfügbar", en: "Not available right now" },
  { name: "signed out", state: { kind: "signed_out" }, de: "Mit Discord anmelden", en: "Sign in with Discord" },
  { name: "no Twitch connection", state: { kind: "no_twitch" }, de: "Twitch-Konto noch nicht verbunden", en: "Twitch account is not connected yet" },
  { name: "linked", state: linkedState, de: "Konten verknüpft", en: "Accounts linked" },
];

describe("Discord linking page copy", () => {
  afterEach(cleanup);

  it.each(cases)("renders the $name state in German and English", ({ state, de, en }) => {
    const view = render(<DiscordLinkView language="de" state={state} />);
    expect(screen.getByRole("heading", { name: de })).toBeInTheDocument();
    if (state.kind === "linked") {
      expect(screen.getByText("nightowl")).toBeInTheDocument();
      expect(screen.getByText("@nightowl_dev")).toBeInTheDocument();
      expect(screen.getByText("Harbor Radio")).toBeInTheDocument();
    }

    view.rerender(<DiscordLinkView language="en" state={state} />);
    expect(screen.getByRole("heading", { name: en })).toBeInTheDocument();
  });

  it("shows the per-channel role state for a linked viewer", () => {
    render(<DiscordLinkView language="en" state={{
      kind: "linked",
      link: linkedState.link,
      channels: [
        { channelId: "fictional-has-role", displayName: "Amber Harbor", status: "has_role" },
        { channelId: "fictional-pending", displayName: "Cinder Bay", status: "pending" },
        { channelId: "fictional-unknown", displayName: "Dawn Pier", status: "unknown" },
      ],
    }} />);

    expect(screen.getByText("Role present")).toBeInTheDocument();
    expect(screen.getByText("Reconciling")).toBeInTheDocument();
    expect(screen.getByText("Status unknown")).toBeInTheDocument();
  });
});
