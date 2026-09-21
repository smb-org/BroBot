import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RaidPanel } from "../../src/modules/raid/panel";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Raid-Panel-Ansicht", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("zeigt die Einstellungen zweisprachig an", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      mindestZuschauer: 3,
      textVoll: "Voll {kanal} {zuschauer}",
      textKlein: "Klein {kanal} {zuschauer}",
    } })));

    render(<RaidPanel channelId="kanal-a" language="en" />);

    expect(await screen.findByRole("heading", { name: "Threshold and messages", level: 2 })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum viewers")).toHaveValue(3);
    expect(screen.getByLabelText("Full raid message")).toHaveValue("Voll {kanal} {zuschauer}");
    expect(screen.getByLabelText("Small raid message")).toHaveValue("Klein {kanal} {zuschauer}");
  });

  it("zeigt Felder für Bediener, deaktiviert sie aber mit Begründung", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      mindestZuschauer: 3,
      textVoll: "voll",
      textKlein: "klein",
    } })));

    render(<RaidPanel channelId="kanal-a" language="de" canManage={false} />);

    expect(await screen.findByText("Nur Broadcaster und Verwalter dürfen Raid-Einstellungen ändern.")).toBeInTheDocument();
    expect(screen.getByLabelText("Mindestzuschauer")).toBeDisabled();
    expect(screen.getByLabelText("Voller Raid-Text")).toBeDisabled();
    expect(screen.getByLabelText("Kurzer Dankestext")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Raid-Einstellungen speichern" })).toBeDisabled();
  });
});
