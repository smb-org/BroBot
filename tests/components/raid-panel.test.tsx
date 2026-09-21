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
      shoutoutAktiv: true,
      shoutoutSchwelle: 3,
      textSchwelle: 3,
      textVoll: "Voll {channel} {viewers}",
      textKlein: "Klein {channel} {viewers}",
    } })));

    render(<RaidPanel channelId="kanal-a" language="en" />);

    expect(await screen.findByRole("heading", { name: "Shoutout and messages", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Automatic Helix shoutout: enabled" })).toBeChecked();
    expect(screen.getByLabelText("Shoutout threshold (viewers)")).toHaveValue(3);
    expect(screen.getByLabelText("Text threshold (viewers)")).toHaveValue(3);
    expect(screen.getByLabelText("Full raid message")).toHaveValue("Voll {channel} {viewers}");
    expect(screen.getByLabelText("Small raid message")).toHaveValue("Klein {channel} {viewers}");
  });

  it("zeigt Felder für Bediener, deaktiviert sie aber mit Begründung", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      shoutoutAktiv: true,
      shoutoutSchwelle: 3,
      textSchwelle: 3,
      textVoll: "voll",
      textKlein: "klein",
    } })));

    render(<RaidPanel channelId="kanal-a" language="de" canManage={false} />);

    expect(await screen.findByText("Nur Broadcaster und Verwalter dürfen Raid-Einstellungen ändern.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Helix-Shoutout automatisch senden: eingeschaltet" })).toBeDisabled();
    expect(screen.getByLabelText("Shoutout-Schwelle (Zuschauer)")).toBeDisabled();
    expect(screen.getByLabelText("Text-Schwelle (Zuschauer)")).toBeDisabled();
    expect(screen.getByLabelText("Voller Raid-Text")).toBeDisabled();
    expect(screen.getByLabelText("Kurzer Dankestext")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Raid-Einstellungen speichern" })).toBeDisabled();
  });

  it("zeigt die abgeschaltete Shoutout-Schwelle deaktiviert, lässt die Text-Schwelle aber bedienbar", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      shoutoutAktiv: false,
      shoutoutSchwelle: 50,
      textSchwelle: 5,
      textVoll: "voll",
      textKlein: "klein",
    } })));

    render(<RaidPanel channelId="kanal-a" language="de" />);

    expect(await screen.findByRole("switch", { name: "Helix-Shoutout automatisch senden: ausgeschaltet" })).not.toBeChecked();
    expect(screen.getByLabelText("Shoutout-Schwelle (Zuschauer)")).toBeDisabled();
    expect(screen.getByLabelText("Text-Schwelle (Zuschauer)")).toBeEnabled();
  });
});
