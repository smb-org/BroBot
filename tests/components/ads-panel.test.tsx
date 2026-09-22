import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WerbungPanel } from "../../src/modules/ads/panel";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Werbung-Panel-Ansicht", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("bindet die Feldgestaltung gemeinsam an die Panel-Hülle", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/dashboard/styles.css"), "utf8");

    expect(styles).toMatch(/\.inspector-form label,\s*\.content-section label,\s*\.module-stack label/);
    expect(styles).toMatch(/\.module-stack label\s*\{ display: grid/);
    expect(styles).toMatch(/:is\(\.inspector-form, \.content-section, \.module-stack\) input/);
    expect(styles).toMatch(/:is\(\.inspector-form, \.content-section, \.module-stack\) textarea/);
    expect(styles).toMatch(/:is\(\.inspector-form, \.content-section, \.module-stack\) select/);
    expect(styles).toMatch(/--config-field-schmal:\s*9rem/);
    expect(styles).toMatch(/--config-field-mittel:\s*20rem/);
    expect(styles).toMatch(/--config-field-breit:\s*40rem/);
  });

  it.each([
    ["de-DE", "Automatische Ansage", "Automatische Werbepause", "Manuelle Ansage", "Manuell gestartete Werbepause", "Aktionen", "Ansagen speichern"],
    ["en-US", "Automatic announcement", "Automatic ad break", "Manual announcement", "Manually started ad break", "Actions", "Save announcements"],
  ])("rendert Felder und Abschnitte auf %s", async (browserLanguage, automaticHeading, automaticLabel, manualHeading, manualLabel, actionsHeading, saveLabel) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      automatisch: "Automatisch {duration}",
      manuell: "Manuell {duration}",
    } })));
    Object.defineProperty(window.navigator, "language", { value: browserLanguage, configurable: true });

    render(<WerbungPanel channelId="kanal-a" />);

    expect(await screen.findByRole("heading", { name: automaticHeading, level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: manualHeading, level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: actionsHeading, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: saveLabel })).toBeInTheDocument();

    const textareas = await screen.findAllByRole("textbox");
    expect(textareas).toHaveLength(2);
    expect(textareas.map((textarea) => textarea.closest("label")?.className)).toEqual([
      "config-field config-field--breit",
      "config-field config-field--breit",
    ]);
    expect(textareas[0]?.closest("label")).toHaveTextContent(automaticLabel);
    expect(textareas[1]?.closest("label")).toHaveTextContent(manualLabel);
    for (const textarea of textareas) {
      const field = textarea.closest("label");
      const hint = field?.querySelector(".config-field__hint");
      expect(hint).not.toBeNull();
      expect(textarea.compareDocumentPosition(hint as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("zeigt Snooze ohne Scope sichtbar, deaktiviert und mit Zähler sowie Aufladezeitpunkt", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (path.endsWith("/zeitplan")) {
        return Promise.resolve(jsonResponse({
          schedule: {
            nextAdAt: "2026-09-21T12:00:00Z",
            duration: 60,
            lastAdAt: null,
            prerollFreeTime: 120,
            snoozeCount: 0,
            snoozeRefreshAt: "2026-09-21T12:30:00Z",
          },
          snoozeScopeVorhanden: false,
          letzteWerbepausen: [],
        }));
      }
      return Promise.resolve(jsonResponse({ settings: {
        automatisch: "auto {duration}",
        manuell: "manuell {duration}",
        vorwarnung: true,
        vorlaufSekunden: 60,
        vorwarnungText: "gleich {seconds}",
      } }));
    }));

    render(<WerbungPanel channelId="kanal-a" language="de" />);

    const button = await screen.findByRole("button", { name: /Snooze.*0.*Aufladung/ });
    expect(button).toBeDisabled();
    expect(screen.getByText(/channel:manage:ads fehlt/)).toBeInTheDocument();
  });

  it("zeigt einen leeren Zeitplan ruhig und listet die letzten Werbepausen", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (path.endsWith("/zeitplan")) {
        return Promise.resolve(jsonResponse({
          schedule: {
            nextAdAt: null,
            duration: null,
            lastAdAt: null,
            prerollFreeTime: null,
            snoozeCount: null,
            snoozeRefreshAt: null,
          },
          snoozeScopeVorhanden: true,
          letzteWerbepausen: [{ zeitpunkt: "2026-09-21T11:00:00Z", dauerSekunden: 90 }],
        }));
      }
      return Promise.resolve(jsonResponse({ settings: {
        automatisch: "auto {duration}",
        manuell: "manuell {duration}",
        vorwarnung: true,
        vorlaufSekunden: 60,
        vorwarnungText: "gleich {seconds}",
      } }));
    }));

    render(<WerbungPanel channelId="kanal-a" language="de" />);

    expect(await screen.findByText("Derzeit ist keine Werbung geplant.")).toBeInTheDocument();
    expect(await screen.findByText(/90 Sekunden/)).toBeInTheDocument();
    // Tests laufen in UTC (siehe package.json), damit derselbe Zeitpunkt überall
    // gleich formatiert wird: 11:00Z bleibt 11:00 statt zur Zeitzone der Maschine
    // zu wandern.
    expect(screen.getByText(/11:00/)).toBeInTheDocument();
  });

  it("behandelt eine geleerte Vorlaufzeit als Feldfehler statt als null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (path.endsWith("/zeitplan")) return Promise.resolve(jsonResponse({
        schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: null, snoozeRefreshAt: null },
        snoozeScopeVorhanden: true, letzteWerbepausen: [],
      }));
      if (path.endsWith("/settings") && init?.method === undefined) return Promise.resolve(jsonResponse({ settings: {
        automatisch: "auto {duration}", manuell: "manuell {duration}", vorwarnung: true, vorlaufSekunden: 60, vorwarnungText: "gleich {seconds}",
      } }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<WerbungPanel channelId="kanal-a" language="de" />);
    const field = await screen.findByLabelText("Vorlaufzeit (Sekunden)");
    fireEvent.change(field, { target: { value: "" } });
    expect((field as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Ansagen speichern" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Zahl eingeben");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect((field as HTMLInputElement).value).toBe("");
  });
});
