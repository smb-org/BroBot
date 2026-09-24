import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModulePage } from "../../src/dashboard/module-panels";
import { UiProvider } from "../../src/dashboard/ui";
import type { AdsScheduleResponse } from "../../src/modules/ads/contracts";
import { jsonResponse } from "../unit/fixtures";

const settings = {
  automatic: "Werbepause beginnt",
  manual: "Manuell gestartete Werbung",
  prewarning: false,
  leadSeconds: 60,
  prewarningText: "Werbung in {seconds} Sekunden.",
};
const schedule: AdsScheduleResponse = {
  schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: 2, snoozeRefreshAt: null },
  snoozeScopeAvailable: true,
  recentAdBreaks: [],
};
const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");

const renderAds = (fetcher: typeof fetch, ownRole: "manager" | "operator" = "manager"): ReturnType<typeof render> => {
  vi.stubGlobal("fetch", fetcher);
  return render(<UiProvider><ModulePage
    channelId="kanal-a"
    moduleId="ads"
    ownRole={ownRole}
    modules={[{ id: "ads", enabled: true, settings: "{}" }]}
    activeModules={[{ moduleId: "ads", settings: "{}" }]}
    onNavigate={vi.fn()}
    onToggle={vi.fn()}
  /></UiProvider>);
};

const adsFetch = (
  patch: () => Response = () => jsonResponse({ settings, warnings: [] }),
  scheduleValue: AdsScheduleResponse = schedule,
  snooze: () => Response = () => jsonResponse(scheduleValue),
) =>
  vi.fn<typeof fetch>((input, init) => {
    const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
    if (path.endsWith("/settings") && init?.method === "PATCH") return Promise.resolve(patch());
    if (path.endsWith("/settings")) return Promise.resolve(jsonResponse({ settings, revision: 1, variables: [] }));
    if (path.endsWith("/schedule")) return Promise.resolve(jsonResponse(scheduleValue));
    if (path.endsWith("/snooze") && init?.method === "POST") return Promise.resolve(snooze());
    if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
    return Promise.resolve(jsonResponse({}, 404));
  });

describe("Ad settings editor declaration", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (initialLanguage !== undefined) Object.defineProperty(window.navigator, "language", initialLanguage);
  });

  it("previews the duration fallback, counts its 15 characters, and disables prewarning fields when off", async () => {
    renderAds(adsFetch());

    const announcementsTab = await screen.findByRole("tab", { name: "Ansagen" });
    const prewarningTab = screen.getByRole("tab", { name: "Vorwarnung" });
    expect(announcementsTab.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(prewarningTab.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByText("Werbepause beginnt (90 Sekunden)")).toBeInTheDocument();
    expect(screen.getAllByText(/Ohne \{duration\} ergänzt die Vorschau \(N Sekunden\)\./)).toHaveLength(2);

    const automatic = screen.getByRole("textbox", { name: "Automatische Werbepause" });
    fireEvent.change(automatic, { target: { value: "x".repeat(486) } });
    expect(await screen.findByText(/bis zu 501 Zeichen/)).toBeInTheDocument();

    fireEvent.click(prewarningTab);
    expect(screen.getByRole("switch", { name: /Vorwarnung vor der Werbung/ })).not.toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Vorlaufzeit" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Vorwarnungstext" })).toBeDisabled();
    expect(screen.getAllByText("Vorwarnung ist ausgeschaltet.")).toHaveLength(3);
  });

  it("keeps the announcement draft after a 409 and lists settings for operators", async () => {
    const fetcher = adsFetch(() => jsonResponse({ error: "module_settings_changed_concurrently" }, 409));
    renderAds(fetcher);
    const field = await screen.findByRole("textbox", { name: "Automatische Werbepause" });
    fireEvent.change(field, { target: { value: "Mein Entwurf {duration}" } });
    fireEvent.click(screen.getByRole("button", { name: "Ansagen speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Ansagen-Einstellungen wurden inzwischen geändert.");
    expect(field).toHaveValue("Mein Entwurf {duration}");

    cleanup();
    renderAds(adsFetch(), "operator");
    expect(await screen.findByText("Nur Broadcaster und Verwalter dürfen Ansagen-Einstellungen ändern.")).toBeInTheDocument();
    const properties = document.querySelector("dl.ui-settings-editor__properties");
    expect(properties).not.toBeNull();
    expect(within(properties as HTMLElement).getByText("Vorwarnung vor der Werbung")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Aus")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ansagen speichern" })).not.toBeInTheDocument();
  });

  it("keeps snooze as an immediate panel action above the declaration editor", async () => {
    const fetcher = adsFetch();
    renderAds(fetcher);
    const editor = await screen.findByRole("region", { name: "Ansagen-Einstellungen" });
    const view = editor.closest(".module-view");
    expect(view?.firstElementChild).toHaveAttribute("aria-label", "Ansagen");
    expect(view?.lastElementChild).toBe(editor);

    fireEvent.click(await screen.findByRole("button", { name: /Snooze · 2 verfügbar/ }));
    expect(await screen.findByText("Die nächste Werbepause wurde verschoben.")).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("keeps snooze visible but disabled when its scope is unavailable", async () => {
    const fetcher = adsFetch(undefined, {
      ...schedule,
      schedule: { ...schedule.schedule, snoozeCount: 0, snoozeRefreshAt: "2026-09-23T12:30:00.000Z" },
      snoozeScopeAvailable: false,
    });
    renderAds(fetcher);

    expect(await screen.findByRole("button", { name: /Snooze · 0 verfügbar/ })).toBeDisabled();
    expect(screen.getByText(/channel:manage:ads fehlt/)).toBeInTheDocument();
  });

  it("shows a rejected snooze beside its action without making the settings draft dirty", async () => {
    const fetcher = adsFetch(undefined, schedule, () => jsonResponse({ error: "ad_snooze_failed" }, 500));
    renderAds(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: /Snooze · 2 verfügbar/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Die nächste Werbepause konnte nicht verschoben werden.");
    expect(screen.getByRole("button", { name: "Ansagen speichern" })).toBeDisabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("shows an empty schedule calmly and lists recent ad breaks", async () => {
    renderAds(adsFetch(undefined, {
      schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: null, snoozeRefreshAt: null },
      snoozeScopeAvailable: true,
      recentAdBreaks: [{ timestamp: "2026-09-23T11:00:00.000Z", durationSeconds: 90 }],
    }));

    expect(await screen.findByText("Derzeit ist keine Werbung geplant.")).toBeInTheDocument();
    expect(await screen.findByRole("cell", { name: "90 Sekunden" })).toBeInTheDocument();
    expect(screen.getByText(/11:00/)).toBeInTheDocument();
  });

  it("updates the cached schedule and its as-of label from panel realtime", async () => {
    const original = {
      ...schedule,
      schedule: { ...schedule.schedule, nextAdAt: "2026-09-24T17:00:00.000Z", duration: 60 },
      asOf: "2026-09-24T12:00:00.000Z",
    };
    const formatter = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" });
    const fetcher = adsFetch(undefined, original);
    renderAds(fetcher);

    expect(await screen.findByText(`Stand ${formatter.format(new Date(original.asOf))}`)).toBeInTheDocument();
    window.dispatchEvent(new CustomEvent("brobot:realtime", { detail: {
      version: 1,
      id: "ads-schedule-2",
      createdAt: "2026-09-24T13:00:00.000Z",
      channelId: "kanal-a",
      type: "ads.schedule.updated",
      payload: {
        schedule: { ...original.schedule, nextAdAt: "2026-09-24T18:00:00.000Z", snoozeCount: 1 },
        asOf: "2026-09-24T13:00:00.000Z",
      },
    } }));

    expect(await screen.findByText(`Stand ${formatter.format(new Date("2026-09-24T13:00:00.000Z"))}`)).toBeInTheDocument();
  });

  it("keeps a cleared prewarning lead time empty and blocks the save", async () => {
    const fetcher = adsFetch();
    renderAds(fetcher);
    fireEvent.click(await screen.findByRole("tab", { name: "Vorwarnung" }));
    fireEvent.click(screen.getByRole("switch", { name: /Vorwarnung vor der Werbung/ }));
    const field = screen.getByRole("spinbutton", { name: "Vorlaufzeit" });
    fireEvent.change(field, { target: { value: "" } });
    expect(field).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Ansagen speichern" }));

    expect(await screen.findByText(/Zahl eingeben/u)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(field).toHaveValue("");
  });
});
