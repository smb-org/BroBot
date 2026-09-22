import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdsPanel } from "../../src/modules/ads/panel";
import { loadAdSettings } from "../../src/modules/ads/panel/service";
import { loadRaidSettings } from "../../src/modules/raid/panel/service";
import { RaidPanel } from "../../src/modules/raid/panel";
import { loadTextCommands } from "../../src/modules/text_commands/panel/service";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Raid panel view", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the settings bilingually", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "Voll {channel} {viewers}",
      textShort: "Klein {channel} {viewers}",
    } })));

    render(<RaidPanel channelId="kanal-a" language="en" />);

    expect(await screen.findByRole("heading", { name: "Shoutout and messages", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Automatic Helix shoutout: enabled" })).toBeChecked();
    expect(screen.getByLabelText("Shoutout threshold (viewers)")).toHaveValue(3);
    expect(screen.getByLabelText("Text threshold (viewers)")).toHaveValue(3);
    expect(screen.getByLabelText("Full raid message")).toHaveValue("Voll {channel} {viewers}");
    expect(screen.getByLabelText("Small raid message")).toHaveValue("Klein {channel} {viewers}");
  });

  it("shows fields for operators but disables them with a reason", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "voll",
      textShort: "klein",
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

  it("shows the disabled shoutout threshold as disabled but leaves the text threshold usable", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      shoutoutEnabled: false,
      shoutoutThreshold: 50,
      textThreshold: 5,
      textLong: "voll",
      textShort: "klein",
    } })));

    render(<RaidPanel channelId="kanal-a" language="de" />);

    expect(await screen.findByRole("switch", { name: "Helix-Shoutout automatisch senden: ausgeschaltet" })).not.toBeChecked();
    expect(screen.getByLabelText("Shoutout-Schwelle (Zuschauer)")).toBeDisabled();
    expect(screen.getByLabelText("Text-Schwelle (Zuschauer)")).toBeEnabled();
  });

  it("hides the success message after a further change in both panels", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/raid/settings")) return Promise.resolve(jsonResponse({ settings: {
        shoutoutEnabled: true, shoutoutThreshold: 3, textThreshold: 3, textLong: "voll", textShort: "klein",
      } }));
      if (url.pathname.endsWith("/ads/schedule")) return Promise.resolve(jsonResponse({
        schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: null, snoozeRefreshAt: null },
        snoozeScopeAvailable: true, recentAdBreaks: [],
      }));
      if (url.pathname.endsWith("/ads/settings")) return Promise.resolve(jsonResponse({ settings: {
        automatic: "auto {duration}", manual: "manuell {duration}", prewarning: true, leadSeconds: 60, prewarningText: "gleich {seconds}",
      } }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (init?.method === "PATCH") return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<RaidPanel channelId="kanal-a" language="de" />);
    const raidText = await screen.findByLabelText("Voller Raid-Text");
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("gespeichert");
    fireEvent.change(raidText, { target: { value: "neu" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    cleanup();
    render(<AdsPanel channelId="kanal-a" language="de" />);
    const adText = (await screen.findAllByRole("textbox"))[0];
    if (adText === undefined) throw new Error("Werbungstextfeld fehlt");
    fireEvent.click(screen.getByRole("button", { name: "Ansagen speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("gespeichert");
    fireEvent.change(adText, { target: { value: "neu" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("treats a cleared raid number field as a field error, not null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/raid/settings") && init?.method === undefined) return Promise.resolve(jsonResponse({ settings: {
        shoutoutEnabled: true, shoutoutThreshold: 3, textThreshold: 3, textLong: "voll", textShort: "klein",
      } }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<RaidPanel channelId="kanal-a" language="de" />);
    const field = await screen.findByLabelText("Text-Schwelle (Zuschauer)");
    fireEvent.change(field, { target: { value: "" } });
    expect((field as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Raid-Einstellungen speichern" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Zahl eingeben");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("propagates expired sessions from all three panel services as PanelApiError with status 401", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "Sitzung abgelaufen" }, 401)));

    for (const load of [
      () => loadTextCommands("kanal-a"),
      () => loadRaidSettings("kanal-a"),
      () => loadAdSettings("kanal-a"),
    ]) {
      await expect(load()).rejects.toMatchObject({ name: "PanelApiError", status: 401 });
    }
  });
});
