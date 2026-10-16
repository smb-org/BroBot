import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModulePage } from "../../src/dashboard/module-panels";
import { UiProvider } from "../../src/dashboard/ui";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import type { AdsScheduleResponse } from "../../src/modules/ads/contracts";
import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import { reconcileDashboardPanelResourceRevisions, setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { renderWithQuery } from "../query-test-utils";
import { jsonResponse } from "../unit/fixtures";

const settings = {
  automatic: "Werbepause beginnt",
  manual: "Manuell gestartete Werbung",
  leadSeconds: 60,
  prewarningText: "",
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
  patch: () => Response | Promise<Response> = () => jsonResponse({ settings, warnings: [] }),
  scheduleValue: AdsScheduleResponse = schedule,
  snooze: () => Response = () => jsonResponse(scheduleValue),
) =>
  vi.fn<typeof fetch>((input, init) => {
    const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
    if (path.endsWith("/settings") && init?.method === "PATCH") return Promise.resolve(patch());
    if (path.includes("/modules/ads/") && path.endsWith("/settings")) return Promise.resolve(jsonResponse({ settings, revision: 1, variables: [] }));
    if (path === "/api/channels/kanal-a/settings") return Promise.resolve(jsonResponse({ defaultChatTarget: "source_only", defaultChatTargetRevision: 1, timeZone: "Europe/Berlin", revision: 1 }));
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

  it("renders the schedule and announcement settings in the page columns", async () => {
    renderAds(adsFetch());

    expect(await screen.findByRole("heading", { level: 1, name: "Werbung" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Automatische Werbepause" })).toBeInTheDocument();
    expect(document.querySelector(".settings-page__columns--3")).not.toBeNull();
    expect(await screen.findByText("Letzte Werbung")).toBeInTheDocument();
    expect(screen.getAllByText("Nächste Werbung")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(document.querySelector(".page-header__save .ui-save-bar")).not.toBeNull();
  });

  it("previews the duration fallback and uses blank text as the only message switch", async () => {
    renderAds(adsFetch());

    await screen.findByRole("textbox", { name: "Automatische Werbepause" });
    expect(screen.getByText("Werbepause beginnt (90 Sekunden)")).toBeInTheDocument();
    const automatic = screen.getByRole("textbox", { name: "Automatische Werbepause" });
    fireEvent.change(automatic, { target: { value: "x".repeat(486) } });
    expect(await screen.findByText(/bis zu 501 Zeichen/)).toBeInTheDocument();

    const prewarning = screen.getByRole("textbox", { name: "Vorwarnung" });
    expect(prewarning).toHaveValue("");
    expect(screen.getByText("Nachricht ausgeschaltet")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Vorwarnung/ })).not.toBeInTheDocument();
    fireEvent.change(prewarning, { target: { value: "Werbung in {ads.seconds} Sekunden." } });
    expect(document.querySelector('.ui-settings-editor__message[data-enabled="true"]')).toHaveTextContent("An");
  });

  it("keeps the announcement draft after a 409 and lists settings for operators", async () => {
    const fetcher = adsFetch(() => jsonResponse({ error: "module_settings_changed_concurrently" }, 409));
    renderAds(fetcher);
    const field = await screen.findByRole("textbox", { name: "Automatische Werbepause" });
    fireEvent.change(field, { target: { value: "Mein Entwurf {ads.duration}" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(document.querySelector(".page-header__save [role=status]")).toHaveTextContent("Ansagen-Einstellungen wurden inzwischen geändert."));
    expect(field).toHaveValue("Mein Entwurf {ads.duration}");
    expect(toastsSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: "error", message: "Ansagen-Einstellungen wurden inzwischen geändert." }),
    ]));
    const conflictToast = toastsSnapshot().find(({ message }) => message === "Ansagen-Einstellungen wurden inzwischen geändert.");
    if (conflictToast !== undefined) dismissToast(conflictToast.id);

    cleanup();
    renderAds(adsFetch(), "operator");
    expect(await screen.findByText("Nur Broadcaster und Verwalter dürfen Module ändern.")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll("dl.ui-settings-editor__properties")).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "Werbeplan aktualisieren" })).toBeDisabled();
    expect(screen.getByText("Nur Broadcaster und Verwalter dürfen den Werbeplan aktualisieren.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Snooze · 2 verfügbar/ })).toBeDisabled();
    expect(screen.getByText("Nur Broadcaster und Verwalter dürfen Werbepausen verschieben.")).toBeInTheDocument();
    const properties = document.querySelectorAll("dl.ui-settings-editor__properties");
    expect(properties).toHaveLength(2);
    expect(within(properties[1] as HTMLElement).getByText("Vorwarnung")).toBeInTheDocument();
    expect(within(properties[1] as HTMLElement).getByText("Aus")).toBeInTheDocument();
    expect(document.querySelectorAll(".page-header__lock")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
  });

  it("reuses a pending settings save when navigation asks to save and switch", async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const pendingPatch = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    const fetcher = adsFetch(() => pendingPatch);
    renderAds(fetcher);

    const automatic = await screen.findByRole("textbox", { name: "Automatische Werbepause" });
    fireEvent.change(automatic, { target: { value: "Gespeicherter Entwurf {ads.duration}" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));

    let navigated = false;
    act(() => runDashboardNavigationGuards(() => { navigated = true; }, () => undefined));
    const dialog = await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen" });
    expect(within(dialog).getByRole("button", { name: "Speichern und wechseln" })).toBeDisabled();
    expect(navigated).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);

    resolvePatch?.(jsonResponse({ settings: { ...settings, automatic: "Gespeicherter Entwurf {ads.duration}" }, revision: 2, warnings: [] }));
    await waitFor(() => expect(navigated).toBe(true));
    expect(screen.queryByRole("dialog", { name: "Ungespeicherte Änderungen" })).not.toBeInTheDocument();
    expect(automatic).toHaveValue("Gespeicherter Entwurf {ads.duration}");
  });

  it("loads the server version after an explicit conflict reload", async () => {
    let settingsReads = 0;
    const serverSettings = { ...settings, automatic: "Serverstand {ads.duration}" };
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/modules/ads/settings") && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ error: "module_settings_changed_concurrently" }, 409));
      }
      if (path.endsWith("/modules/ads/settings")) {
        settingsReads += 1;
        return Promise.resolve(jsonResponse({ settings: settingsReads === 1 ? settings : serverSettings, revision: settingsReads, variables: [] }));
      }
      if (path === "/api/channels/kanal-a/settings") return Promise.resolve(jsonResponse({ defaultChatTarget: "source_only", defaultChatTargetRevision: 1, timeZone: "Europe/Berlin", revision: 1 }));
      if (path.endsWith("/schedule")) return Promise.resolve(jsonResponse(schedule));
      return Promise.resolve(jsonResponse({}));
    });
    renderAds(fetcher);

    const automatic = await screen.findByRole("textbox", { name: "Automatische Werbepause" });
    fireEvent.change(automatic, { target: { value: "Mein Entwurf {ads.duration}" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await screen.findByRole("button", { name: "Serverstand laden" });
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Automatische Werbepause" })).toHaveValue("Serverstand {ads.duration}"));
    expect(screen.queryByRole("button", { name: "Serverstand laden" })).not.toBeInTheDocument();
    expect(settingsReads).toBe(3);
  });

  it("keeps snooze as an immediate panel action above the declaration editor", async () => {
    const fetcher = adsFetch();
    renderAds(fetcher);
    await screen.findByRole("textbox", { name: "Automatische Werbepause" });
    await screen.findByRole("button", { name: /Snooze · 2 verfügbar/ });
    const columns = document.querySelector(".settings-page__columns--3");
    const panel = columns?.querySelector(".settings-page__column:first-child section[aria-label='Ansagen']");
    const editor = columns?.querySelector(".settings-page__column:nth-child(2) .ui-settings-editor");
    if (panel === null || panel === undefined || editor === null || editor === undefined) {
      throw new Error("The ads panel and settings editor should both be mounted.");
    }
    expect(panel.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

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
    expect(screen.getByTestId("ads-snooze-result-slot")).toHaveTextContent(/autorisiere ads für diesen kanal erneut und erteile diese berechtigung/i);
  });

  it("shows the remaining Twitch wait when snooze returns a rate-limit reset", async () => {
    const retryAfter = Date.now() + 8_000;
    const fetcher = adsFetch(undefined, schedule, () => jsonResponse({
      error: "ad_snooze_failed",
      reason: "rate_limited",
      detail: { retryAfter },
    }, 429));
    renderAds(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: /Snooze · 2 verfügbar/ }));

    await waitFor(() => expect(toastsSnapshot().some((toast) =>
      toast.tone === "error" && /Versuche es in \d+ Sekunden erneut/u.test(toast.message))).toBe(true));
    expect(await screen.findByTestId("ads-snooze-result-slot")).toHaveTextContent(/Versuche es in \d+ Sekunden erneut/u);
  });

  it("shows the remaining Twitch rate limit wait when the schedule request includes retryAfter", async () => {
    const retryAfter = Date.now() + 8_000;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path.endsWith("/schedule")) return Promise.resolve(jsonResponse({
        error: "ad_schedule_read_failed",
        reason: "rate_limited",
        detail: { retryAfter },
      }, 429));
      if (path.includes("/modules/ads/") && path.endsWith("/settings")) return Promise.resolve(jsonResponse({ settings, revision: 1, variables: [] }));
      if (path === "/api/channels/kanal-a/settings") return Promise.resolve(jsonResponse({ defaultChatTarget: "source_only", defaultChatTargetRevision: 1, timeZone: "Europe/Berlin", revision: 1 }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderAds(fetcher);

    await waitFor(() => expect(toastsSnapshot().some((toast) => /versuche es in \d+ sekunden erneut/i.test(toast.message))).toBe(true));
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
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("shows an empty schedule calmly and lists recent ad breaks", async () => {
    renderAds(adsFetch(undefined, {
      schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: null, snoozeRefreshAt: null },
      snoozeScopeAvailable: true,
      recentAdBreaks: [{ timestamp: "2026-09-23T11:00:00.000Z", durationSeconds: 90 }],
    }));

    expect(await screen.findByText(/Derzeit ist keine Werbung geplant\./u)).toBeInTheDocument();
    expect(screen.getAllByText("Nicht verfügbar").length).toBeGreaterThan(0);
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
    await screen.findByRole("textbox", { name: "Vorwarnung" });
    const field = screen.getByRole("spinbutton", { name: "Vorlaufzeit" });
    fireEvent.change(field, { target: { value: "" } });
    expect(field).toHaveValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByText(/Zahl eingeben/u)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(field).toHaveValue(null);
  });
});
