import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DiscordLinkView, type DiscordLinkPageState } from "../../src/modules/discord/public-page";

const linkedState: DiscordLinkPageState = {
  kind: "linked",
  link: { discordUsername: "nightowl", twitchLogin: "nightowl_dev", linkedAt: "2026-11-24T10:00:00.000Z" },
};

const cases: readonly { name: string; state: DiscordLinkPageState; de: string; en: string }[] = [
  { name: "not configured", state: { kind: "not_configured" }, de: "Derzeit nicht verfügbar", en: "Not available right now" },
  { name: "signed out", state: { kind: "signed_out" }, de: "Mit Discord anmelden", en: "Sign in with Discord" },
  { name: "no Twitch connection", state: { kind: "no_twitch" }, de: "Twitch-Konto noch nicht verbunden", en: "Twitch account is not connected yet" },
  { name: "linked", state: linkedState, de: "Konten verknüpft", en: "Accounts linked" },
];

describe("Discord linking page copy", () => {
  it.each(cases)("renders the $name state in German and English", ({ state, de, en }) => {
    const view = render(<DiscordLinkView language="de" state={state} />);
    expect(screen.getByRole("heading", { name: de })).toBeInTheDocument();
    if (state.kind === "linked") {
      expect(screen.getByText("nightowl")).toBeInTheDocument();
      expect(screen.getByText("@nightowl_dev")).toBeInTheDocument();
    }

    view.rerender(<DiscordLinkView language="en" state={state} />);
    expect(screen.getByRole("heading", { name: en })).toBeInTheDocument();
  });
});
