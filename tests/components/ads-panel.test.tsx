import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModulePage } from "../../src/dashboard/module-panels";
import { UiProvider } from "../../src/dashboard/ui";
import { toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import type { AdsScheduleResponse } from "../../src/modules/ads/contracts";
import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import { reconcileDashboardPanelResourceRevisions, setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { renderWithQuery } from "../query-test-utils";
import { jsonResponse } from "../unit/fixtures";

const settings = {
  automatic: "Werbepause beginnt",
  manual: "Manuell gestartete Werbung",
  prewarning: false,
  leadSeconds: 60,
  prewarningText: "Werbung in {ads.seconds} Sekunden.",
};
const schedule: AdsScheduleResponse = {
  schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: 2, snoozeRefreshAt: null },
  snoozeScopeAvailable: true,
  recentAdBreaks: [],
};
const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");
const requestPath = (input: RequestInfo | URL): string => input instanceof Request
  ? new URL(input.url).pathname
  : input instanceof URL ? input.pathname : new URL(input, "https://brobot.example").pathname;

const renderAds = (
  fetcher: typeof fetch,
  ownRole: "manager" | "operator" = "manager",
  channelId = "kanal-a",
): ReturnType<typeof renderWithQuery> => {
  vi.stubGlobal("fetch", fetcher);
  return renderWithQuery(<UiProvider><ModulePage
    channelId={channelId}
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
    setDashboardRealtimeStatus("kanal-a", "offline");
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
    const durationHints = screen.getAllByRole("button", { name: /Ohne \{ads\.duration\} ergänzt die Vorschau \(N Sekunden\)\./ });
    expect(durationHints).toHaveLength(2);
    for (const hint of durationHints) expect(hint).toHaveAttribute("title", expect.stringContaining("Ohne {ads.duration}"));

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
    fireEvent.change(field, { target: { value: "Mein Entwurf {ads.duration}" } });
    fireEvent.click(screen.getByRole("button", { name: "Ansagen speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Ansagen-Einstellungen wurden inzwischen geändert.");
    expect(field).toHaveValue("Mein Entwurf {ads.duration}");

    cleanup();
    renderAds(adsFetch(), "operator");
    expect(await screen.findByText("Nur Broadcaster und Verwalter dürfen Ansagen-Einstellungen ändern.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Werbeplan aktualisieren" })).toBeDisabled();
    expect(screen.getByText("Nur Broadcaster und Verwalter dürfen den Werbeplan aktualisieren.")).toBeInTheDocument();
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
    await screen.findByRole("region", { name: "Ansagen-Einstellungen" });
    await screen.findByRole("button", { name: /Snooze · 2 verfügbar/ });
    const view = document.querySelector(".module-view");
    const panel = view?.querySelector(":scope > section[aria-label='Ansagen']");
    const editor = view?.querySelector("section[aria-label='Ansagen-Einstellungen']");
    if (panel === null || panel === undefined || editor === null || editor === undefined) {
      throw new Error("The ads panel and settings editor should both be mounted.");
    }
    expect(panel.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const editorLoadState = view?.lastElementChild;
    expect(editorLoadState).toHaveClass("ui-load-state");
    expect(editorLoadState?.firstElementChild?.firstElementChild).toBe(editor);

    fireEvent.click(await screen.findByRole("button", { name: /Snooze · 2 verfügbar/ }));
    await waitFor(() => expect(toastsSnapshot().some((toast) => toast.message === "Die nächste Werbepause wurde verschoben.")).toBe(true));
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

  it("preserves the cached schedule and limits load notifications to one per outage", async () => {
    setDashboardRealtimeStatus("kanal-a", "connected");
    let scheduleReadFails = false;
    const baseFetcher = adsFetch();
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path.endsWith("/schedule") && scheduleReadFails) return Promise.resolve(jsonResponse({ error: "schedule_unavailable" }, 503));
      return baseFetcher(input, init);
    });
    const view = renderAds(fetcher);
    expect(await screen.findByText(/Derzeit ist keine Werbung geplant\./u)).toBeInTheDocument();
    const key = { queryKey: moduleQueryKey("kanal-a", "ads", "schedule"), exact: true };
    const refresh = async (): Promise<void> => {
      await act(async () => { await view.queryClient.refetchQueries(key, { throwOnError: true }).catch(() => undefined); });
    };

    scheduleReadFails = true;
    await refresh();
    await refresh();
    expect(fetcher.mock.calls.filter(([input]) => requestPath(input).endsWith("/schedule"))).toHaveLength(3);
    expect(view.queryClient.getQueryState(key.queryKey)?.status).toBe("error");
    expect(screen.getByText(/Derzeit ist keine Werbung geplant\./u)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Der Werbeplan konnte nicht geladen werden.");
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
    expect(toastsSnapshot().filter((toast) => toast.message === "Der Werbeplan konnte nicht geladen werden.")).toHaveLength(1);

    scheduleReadFails = false;
    await refresh();
    scheduleReadFails = true;
    await refresh();
    expect(toastsSnapshot().filter((toast) => toast.message === "Der Werbeplan konnte nicht geladen werden.")).toHaveLength(2);
  });

  it("shows a rejected snooze as an error toast without making the settings draft dirty", async () => {
    const fetcher = adsFetch(undefined, schedule, () => jsonResponse({ error: "ad_snooze_failed" }, 500));
    renderAds(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: /Snooze · 2 verfügbar/ }));

    await waitFor(() => expect(toastsSnapshot().some((toast) => toast.tone === "error" && toast.message === "Die nächste Werbepause konnte nicht verschoben werden.")).toBe(true));
    expect(screen.getByRole("button", { name: "Ansagen speichern" })).toBeDisabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("shows an empty schedule calmly and lists recent ad breaks", async () => {
    renderAds(adsFetch(undefined, {
      schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: null, snoozeRefreshAt: null },
      snoozeScopeAvailable: true,
      recentAdBreaks: [{ timestamp: "2026-09-23T11:00:00.000Z", durationSeconds: 90 }],
    }));

    expect(await screen.findByText(/Derzeit ist keine Werbung geplant\./u)).toBeInTheDocument();
    expect(screen.getByText("kein Wert")).toHaveClass("sr-only");
    expect(screen.getByText("—")).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByRole("cell", { name: "90 Sekunden" })).toBeInTheDocument();
    expect(screen.getByText(/11:00/)).toBeInTheDocument();
  });

  it("updates the cached schedule after its resource revision advances", async () => {
    const channelId = "ads-revisions-a";
    const original = {
      ...schedule,
      schedule: { ...schedule.schedule, nextAdAt: "2026-09-24T17:00:00.000Z", duration: 60 },
      asOf: "2026-09-24T12:00:00.000Z",
    };
    const formatter = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" });
    let serverSchedule = original;
    let revision = 1;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === `/api/channels/${channelId}/revisions`) return Promise.resolve(jsonResponse({ revisions: { "module:ads:schedule": revision } }));
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/settings")) return Promise.resolve(jsonResponse({ settings, revision: 1, variables: [] }));
      if (path.endsWith("/schedule")) return Promise.resolve(jsonResponse(serverSchedule));
      if (path.endsWith("/snooze") && init?.method === "POST") return Promise.resolve(jsonResponse(serverSchedule));
      return Promise.resolve(jsonResponse({}, 404));
    });
    const rendered = renderAds(fetcher, "manager", channelId);
    await act(async () => { await reconcileDashboardPanelResourceRevisions(rendered.queryClient, channelId); });

    expect(await screen.findByText(`Stand ${formatter.format(new Date(original.asOf))}`)).toBeInTheDocument();
    serverSchedule = {
      ...original,
      schedule: { ...original.schedule, nextAdAt: "2026-09-24T18:00:00.000Z", snoozeCount: 1 },
      asOf: "2026-09-24T13:00:00.000Z",
    };
    revision = 2;
    await act(async () => { await reconcileDashboardPanelResourceRevisions(rendered.queryClient, channelId); });

    expect(await screen.findByText(`Stand ${formatter.format(new Date("2026-09-24T13:00:00.000Z"))}`)).toBeInTheDocument();
    expect(rendered.queryClient.getQueryState(moduleQueryKey(channelId, "ads", "schedule"))?.isInvalidated).toBe(false);
  });

  it("keeps the newest schedule when its revision advances before the initial response", async () => {
    const channelId = "ads-revisions-b";
    const formatter = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" });
    let serverSchedule = { ...schedule, asOf: "2026-09-24T12:00:00.000Z" };
    let scheduleCalls = 0;
    let revision = 1;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === `/api/channels/${channelId}/revisions`) return Promise.resolve(jsonResponse({ revisions: { "module:ads:schedule": revision } }));
      if (path.endsWith("/schedule")) {
        scheduleCalls += 1;
        return Promise.resolve(jsonResponse(scheduleCalls === 1 ? { ...serverSchedule, asOf: "2026-09-24T12:00:00.000Z" } : serverSchedule));
      }
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/settings")) return Promise.resolve(jsonResponse({ settings, revision: 1, variables: [] }));
      if (path.endsWith("/snooze") && init?.method === "POST") return Promise.resolve(jsonResponse(serverSchedule));
      return Promise.resolve(jsonResponse({}, 404));
    });
    const rendered = renderAds(fetcher, "manager", channelId);
    await waitFor(() => { expect(scheduleCalls).toBe(1); });
    await act(async () => { await reconcileDashboardPanelResourceRevisions(rendered.queryClient, channelId); });

    const newerAsOf = "2026-09-24T13:00:00.000Z";
    serverSchedule = {
      ...schedule,
      schedule: { ...schedule.schedule, nextAdAt: "2026-09-24T18:00:00.000Z", snoozeCount: 0 },
      asOf: newerAsOf,
    };
    revision = 2;
    await act(async () => { await reconcileDashboardPanelResourceRevisions(rendered.queryClient, channelId); });

    expect(await screen.findByText(`Stand ${formatter.format(new Date(newerAsOf))}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Snooze · 0 verfügbar/ })).toBeDisabled();
    expect(scheduleCalls).toBeGreaterThanOrEqual(2);
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
