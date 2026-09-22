import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ReactElement } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { AdsPanel } from "../../src/modules/ads/panel";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const renderPanel = (panel: ReactElement): ReturnType<typeof render> => render(<UiProvider>{panel}</UiProvider>);

describe("Ad panel view", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shares field styling with the panel shell", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/dashboard/styles.css"), "utf8");

    expect(styles).toMatch(/\.inspector-form label(?::not\([^)]*\))?,\s*\.content-section label(?::not\([^)]*\))?,\s*\.module-stack label/);
    expect(styles).toMatch(/\.module-stack label(?::not\([^)]*\))?\s*\{ display: grid/);
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
  ])("renders fields and sections in %s", async (browserLanguage, automaticHeading, automaticLabel, manualHeading, manualLabel, actionsHeading, saveLabel) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      automatic: "Automatisch {duration}",
      manual: "Manuell {duration}",
    } })));
    Object.defineProperty(window.navigator, "language", { value: browserLanguage, configurable: true });

    renderPanel(<AdsPanel channelId="kanal-a" />);

    expect(await screen.findByRole("heading", { name: automaticHeading, level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: manualHeading, level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: actionsHeading, level: 2 })).toBeInTheDocument();
    // The save bar only appears once a field is dirty -- not before.
    expect(screen.queryByRole("button", { name: saveLabel })).not.toBeInTheDocument();

    // `textbox` also matches the prewarning-text `Field`'s single-line
    // input; textareas are the multi-line subset of that role.
    const textareas = (await screen.findAllByRole("textbox")).filter((element) => element.tagName === "TEXTAREA");
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

  it("shows snooze without scope visible, disabled, with counter and refresh time", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (path.endsWith("/schedule")) {
        return Promise.resolve(jsonResponse({
          schedule: {
            nextAdAt: "2026-09-21T12:00:00Z",
            duration: 60,
            lastAdAt: null,
            prerollFreeTime: 120,
            snoozeCount: 0,
            snoozeRefreshAt: "2026-09-21T12:30:00Z",
          },
          snoozeScopeAvailable: false,
          recentAdBreaks: [],
        }));
      }
      return Promise.resolve(jsonResponse({ settings: {
        automatic: "auto {duration}",
        manual: "manuell {duration}",
        prewarning: true,
        leadSeconds: 60,
        prewarningText: "gleich {seconds}",
      } }));
    }));

    renderPanel(<AdsPanel channelId="kanal-a" language="de" />);

    const button = await screen.findByRole("button", { name: /Snooze.*0.*Aufladung/ });
    expect(button).toBeDisabled();
    expect(screen.getByText(/channel:manage:ads fehlt/)).toBeInTheDocument();
  });

  it("shows a rejected snooze beside its action while the settings draft is unchanged", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request
        ? new URL(input.url)
        : new URL(input instanceof URL ? input.toString() : input, window.location.origin);
      if (url.pathname.endsWith("/schedule")) return Promise.resolve(jsonResponse({
        schedule: { nextAdAt: "2026-09-21T12:00:00Z", duration: 60, lastAdAt: null, prerollFreeTime: 120, snoozeCount: 2, snoozeRefreshAt: null },
        snoozeScopeAvailable: true,
        recentAdBreaks: [],
      }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ settings: {
        automatic: "auto {duration}", manual: "manual {duration}", prewarning: true, leadSeconds: 60, prewarningText: "soon {seconds}",
      } }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname.endsWith("/snooze") && init?.method === "POST") return Promise.resolve(jsonResponse({ error: "ad_snooze_failed" }, 500));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    renderPanel(<AdsPanel channelId="kanal-a" language="en" />);

    const snoozeButton = await screen.findByRole("button", { name: /Snooze · 2 available/ });
    expect(screen.queryByRole("button", { name: "Save announcements" })).not.toBeInTheDocument();
    fireEvent.click(snoozeButton);

    expect(await screen.findByRole("alert")).toHaveTextContent("The next ad break could not be postponed.");
    expect(screen.queryByRole("button", { name: "Save announcements" })).not.toBeInTheDocument();
  });

  it("shows an empty schedule calmly and lists recent ad breaks", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (path.endsWith("/schedule")) {
        return Promise.resolve(jsonResponse({
          schedule: {
            nextAdAt: null,
            duration: null,
            lastAdAt: null,
            prerollFreeTime: null,
            snoozeCount: null,
            snoozeRefreshAt: null,
          },
          snoozeScopeAvailable: true,
          recentAdBreaks: [{ timestamp: "2026-09-21T11:00:00Z", durationSeconds: 90 }],
        }));
      }
      return Promise.resolve(jsonResponse({ settings: {
        automatic: "auto {duration}",
        manual: "manuell {duration}",
        prewarning: true,
        leadSeconds: 60,
        prewarningText: "gleich {seconds}",
      } }));
    }));

    renderPanel(<AdsPanel channelId="kanal-a" language="de" />);

    expect(await screen.findByText("Derzeit ist keine Werbung geplant.")).toBeInTheDocument();
    expect(await screen.findByText(/90 Sekunden/)).toBeInTheDocument();
    // Tests run in UTC (see package.json), so the same timestamp formats the
    // same everywhere: 11:00Z stays 11:00 instead of drifting to the machine's
    // timezone.
    expect(screen.getByText(/11:00/)).toBeInTheDocument();
  });

  it("treats a cleared lead time as a field error, not null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (path.endsWith("/schedule")) return Promise.resolve(jsonResponse({
        schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: null, snoozeRefreshAt: null },
        snoozeScopeAvailable: true, recentAdBreaks: [],
      }));
      if (path.endsWith("/settings") && init?.method === undefined) return Promise.resolve(jsonResponse({ settings: {
        automatic: "auto {duration}", manual: "manuell {duration}", prewarning: true, leadSeconds: 60, prewarningText: "gleich {seconds}",
      } }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);

    renderPanel(<AdsPanel channelId="kanal-a" language="de" />);
    const field = await screen.findByLabelText("Vorlaufzeit (Sekunden)");
    fireEvent.change(field, { target: { value: "" } });
    expect((field as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Ansagen speichern" }));

    expect(await screen.findByText("× Zahl eingeben")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect((field as HTMLInputElement).value).toBe("");
  });
});
