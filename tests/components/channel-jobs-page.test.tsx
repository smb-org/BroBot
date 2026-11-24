import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelJobsPage } from "../../src/dashboard/ChannelJobsPage";
import { CHANNEL_JOB_ERROR_TEXTS } from "../../src/contracts/channel-jobs";
import { queryKeys } from "../../src/dashboard/data/keys";
import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { dashboardCommonTexts, dashboardTexts } from "../../src/dashboard/locale";
import type { PanelChannelJob } from "../../src/panel-contract";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const channelId = "channel-jobs-test";
const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

const job = (overrides: Partial<PanelChannelJob> = {}): PanelChannelJob => ({
  id: "host:test_only",
  intervalMs: 60_000,
  label: { de: "Test task", en: "Test job" },
  requiredScopes: ["moderation:read:moderators"],
  state: "idle",
  lastStartedAt: null,
  lastSuccessAt: null,
  nextRunAt: 1_800_000_000_000,
  errorCode: null,
  errorTextKey: null,
  consecutiveFailures: 0,
  resultSummary: null,
  pausedAt: null,
  reconcileNeeded: false,
  ...overrides,
});

const renderPage = (jobs: readonly PanelChannelJob[]) => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf_test" }));
    if (url.pathname.endsWith("/jobs") && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse({ jobs }));
    if (url.pathname.endsWith("/run")) return Promise.resolve(jsonResponse({ result: "already_running" }));
    if (url.pathname.endsWith("/pause")) return Promise.resolve(jsonResponse({ status: { state: "paused" } }));
    if (url.pathname.endsWith("/resume")) return Promise.resolve(jsonResponse({ result: "scheduled" }));
    return Promise.resolve(jsonResponse({}, 404));
  }));
  return renderWithQuery(<UiProvider><ChannelJobsPage channelId={channelId} /><ToastHost /></UiProvider>, undefined, {
    initialData: [{ queryKey: queryKeys.channel(channelId, "jobs"), data: [...jobs] }],
    staleTime: 60_000,
  });
};

describe("channel jobs page", () => {
  afterEach(() => {
    cleanup();
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
    vi.unstubAllGlobals();
    setBrowserLanguage("de-DE");
  });

  it("renders idle, running, paused, and failed status with fixed error copy", async () => {
    setBrowserLanguage("en-US");
    const { container } = renderPage([
      job({ id: "host:idle", label: { de: "Ready task", en: "Idle task" }, resultSummary: { de: "3 Rollen vergeben", en: "3 roles granted" } }),
      job({ id: "host:running", state: "running", lastStartedAt: 1_799_999_000_000, nextRunAt: null }),
      job({ id: "host:paused", state: "paused", pausedAt: 1_799_998_000_000, nextRunAt: null, reconcileNeeded: true }),
      job({ id: "host:failed", state: "failed", errorCode: "missing_scope", errorTextKey: "missing_scope", consecutiveFailures: 2 }),
    ]);

    expect(await screen.findByRole("heading", { name: "Background tasks" })).toBeInTheDocument();
    expect(container.querySelectorAll(".channel-jobs-card")).toHaveLength(4);
    expect(screen.getByText("Idle task")).toBeInTheDocument();
    expect(screen.getByLabelText("Ready")).toBeInTheDocument();
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
    expect(screen.getByText(/Paused since/u)).toBeInTheDocument();
    expect(screen.getByText(/Paused since .* · Changes will be reconciled on the next run\./u)).toBeInTheDocument();
    expect(screen.getByText("3 roles granted")).toBeInTheDocument();
    expect(screen.getByText(CHANNEL_JOB_ERROR_TEXTS.en.missing_scope)).toBeInTheDocument();
  });

  it("shows the localized empty state in German and English", async () => {
    setBrowserLanguage("de-DE");
    const german = renderPage([]);
    const germanLabels = dashboardTexts("de").channelJobs;
    expect(await screen.findByRole("heading", { name: germanLabels.title })).toBeInTheDocument();
    expect(screen.getByText(germanLabels.emptyDescription)).toBeInTheDocument();
    german.unmount();

    setBrowserLanguage("en-US");
    renderPage([]);
    expect(await screen.findByRole("heading", { name: "Background tasks" })).toBeInTheDocument();
    expect(screen.getByText("No background tasks are registered for this channel yet.")).toBeInTheDocument();
  });

  it("shows already-running feedback when Run now returns an active claim", async () => {
    setBrowserLanguage("en-US");
    renderPage([job({ state: "running", lastStartedAt: 1_799_999_000_000, nextRunAt: null })]);
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));

    expect(await screen.findByText("This task is already running.")).toBeInTheDocument();
    await waitFor(() => {
      const fetcher = vi.mocked(fetch);
      expect(fetcher.mock.calls.some(([input, init]) => (input instanceof Request ? input.url : String(input)).endsWith("/run") && init?.method === "POST")).toBe(true);
    });
  });

  it("uses German labels and pauses without an autosave action", async () => {
    setBrowserLanguage("de-DE");
    renderPage([job({ resultSummary: { de: "3 Rollen vergeben", en: "3 roles granted" } })]);
    expect(await screen.findByText("3 Rollen vergeben")).toBeInTheDocument();
    const germanLabels = dashboardTexts("de").channelJobs;
    expect(await screen.findByRole("heading", { name: germanLabels.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: germanLabels.runNow })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: germanLabels.pause })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: dashboardCommonTexts("de").save })).not.toBeInTheDocument();
  });
});
