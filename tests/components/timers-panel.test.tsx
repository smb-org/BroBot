import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { moduleQueryKey } from "../../src/dashboard/data";
import TimersPanel from "../../src/modules/timers/panel";
import { nextRunLabel, triggerDetail } from "../../src/modules/timers/panel/summary";
import type { Timer } from "../../src/modules/timers/contracts";
import { timersTexts } from "../../src/modules/timers/panel/locale";
import type { TimersPanelData } from "../../src/modules/timers/panel/service";
import { inputFromDraft } from "../../src/modules/timers/panel/draft";
import { formatRelativeTime } from "../../src/dashboard/ui/format-relative-time";
import { renderWithQuery } from "../query-test-utils";
import { jsonResponse } from "../unit/fixtures";

const toolbarButton = (name: string): HTMLElement => {
  const toolbar = document.querySelector(".collection-page__list-toolbar");
  if (!(toolbar instanceof HTMLElement)) throw new Error("The timer collection toolbar is missing.");
  return within(toolbar).getByRole("button", { name });
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Timers panel", () => {
  it("places timer status labels before switches at the right edge of each row", async () => {
    const timer: Timer = {
      id: "timer-switch-layout", name: "Greeting timer", enabled: true, messageText: "Hello", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [timer] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    const timerButton = await screen.findByRole("button", { name: /Greeting timer/u });
    const row = timerButton.closest(".timer-list__row");
    const listSwitch = within(row as HTMLElement).getByRole("switch");
    expect(row?.querySelector(':scope > [data-slot="switch"]')).toBe(listSwitch);

    fireEvent.click(timerButton);
    const header = document.querySelector(".timer-header__switch");
    const headerSwitch = within(header as HTMLElement).getByRole("switch");
    expect(header?.firstElementChild).toHaveTextContent("Enabled");
    expect(headerSwitch.previousElementSibling).toHaveTextContent("Enabled");
  });

  it("places weekday switches after their labels", async () => {
    const timer: Timer = {
      id: "timer-weekday-layout", name: "Daily timer", enabled: true, messageText: "Hello", chatTarget: "source_only",
      trigger: { type: "time_of_day", time: "12:00", weekdays: [], alsoOffline: false }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [timer] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Daily timer/u }));

    const mondaySwitch = await screen.findByRole("switch", { name: "Mon" });
    const mondayRow = mondaySwitch.closest(".timer-weekday");
    expect(mondaySwitch.previousElementSibling).toHaveTextContent("Mon");
    expect(mondayRow?.firstElementChild).toHaveTextContent("Mon");
  });

  it("keeps live and offline interval rows visible with an explicit save action", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    fireEvent.click(toolbarButton("Create timer"));

    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Live" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Offline" })).not.toBeChecked();
    expect(screen.getByText(/An enabled offline interval runs separately/u)).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton", { name: "Minutes" })).toHaveLength(1);
    expect(screen.getAllByRole("spinbutton", { name: "Minimum chat messages" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Offline" }));
    expect(screen.getByText(/An enabled offline interval runs separately/u)).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton", { name: "Minutes" })).toHaveLength(2);
    expect(screen.getAllByRole("spinbutton", { name: "Minimum chat messages" })).toHaveLength(2);
    expect(screen.getAllByRole("spinbutton", { name: "Minimum chat messages" })[1]).toHaveAttribute("placeholder", "none");
  });

  it("saves valid interval parts after a hidden trigger's minutes field was cleared", () => {
    const input = inputFromDraft({
      name: "Reminder", messageText: "Hello", chatTarget: null, type: "interval",
      live: { minutes: 30, minimumMessages: "" }, offline: { minutes: 30, minimumMessages: "" },
      minutes: "", time: "12:00", weekdays: [], alsoOffline: false, sourceId: "",
    });

    expect(input?.trigger).toEqual({
      type: "interval", live: { minutes: 30 }, offline: { minutes: 30 },
    });
  });

  it("limits the chat target to all chats or the source chat", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "all_chats", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    fireEvent.click(toolbarButton("Create timer"));
    fireEvent.click(await screen.findByRole("button", { name: "Chat target" }));

    expect(await screen.findByRole("radio", { name: /All chats|Alle Chats/u, hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Only our chat|Nur unser Chat/u, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /channel default|Kanaleinstellung/u, hidden: true })).not.toBeInTheDocument();
  });

  it("shows an inherited timer destination accurately while keeping explicit choices limited", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [{
        id: "timer-default", name: "Inherited destination", enabled: true, messageText: "Hello", chatTarget: null,
        trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
        lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
      }] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "all_chats", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByRole("button", { name: "Chat target" })).toHaveTextContent("Use channel default (All chats)");
    fireEvent.click(screen.getByRole("button", { name: "Chat target" }));
    expect(await screen.findByRole("radio", { name: /All chats/u, hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Only our chat/u, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /channel default/u, hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /All chats/u, hidden: true })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Only our chat/u, hidden: true })).not.toBeChecked();
  });

  it("shows the shared collection and empty state when no timers are configured", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByRole("heading", { name: "Timers" })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".collection-page__empty")).toHaveTextContent("No timers yet"));
    expect(document.querySelector(".collection-page")).toHaveAttribute("data-detail-open", "false");
  });

  it("uses the channel time zone in both the timer list and detail header", async () => {
    const nextRunAt = new Date(Date.now() + 100 * 60 * 60 * 1000).toISOString();
    const timeZone = "Pacific/Kiritimati";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [{
        id: "timer-zone", name: "Timezone check", enabled: true, messageText: "Hello", chatTarget: "source_only",
        trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt, nextRunState: null,
        lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
      }] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone, revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByText("Timezone check")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".page-header__meta")).toBeInTheDocument());
    const expected = formatRelativeTime(nextRunAt, new Date(), "en", timeZone).label;
    expect(document.querySelector(".timer-list__copy small")).toHaveTextContent(`Next run · ${expected}`);
    expect(document.querySelector(".page-header__meta")).toHaveTextContent(`Next run: ${expected}`);
    expect(expected).not.toBe(formatRelativeTime(nextRunAt, new Date(), "en", "UTC").label);
  });

  it("refreshes a timer after an edit is reverted before a realtime update", async () => {
    const timer: Timer = {
      id: "timer-realtime", name: "Greeting timer", enabled: true, messageText: "Hello", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [timer] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    const { queryClient } = renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    const nameField = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(nameField, { target: { value: "Temporary name" } });
    fireEvent.change(nameField, { target: { value: "Greeting timer" } });

    queryClient.setQueryData<TimersPanelData>(moduleQueryKey("channel-a", "timers", "panel"), {
      timers: [{ ...timer, name: "Updated elsewhere", revision: 2 }], sources: [], variables: [],
    });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Updated elsewhere"));
    expect(screen.queryByText("This timer has changed. Reload the current version before continuing.")).not.toBeInTheDocument();
  });

  it("shows cached timers immediately when the panel is mounted again", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [{
        id: "timer-1", name: "Greeting timer", enabled: true, messageText: "Hello there!", chatTarget: "source_only",
        trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
        lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
      }] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const view = renderWithQuery(
      <UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>,
      {},
      { gcTime: 600_000, staleTime: 600_000 },
    );
    expect(await screen.findByText("Greeting timer")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(4);

    view.rerender(<UiProvider>{null}</UiProvider>);
    view.rerender(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(screen.getByText("Greeting timer")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps a committed timer revision when the post-save refresh fails and offers retry", async () => {
    let enabled = true;
    let revision = 1;
    let timerReads = 0;
    let refreshFails = false;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/timers/timer-1/enabled") && method === "PATCH") {
        if (typeof init?.body !== "string") throw new Error("Expected the timer enable request to have a JSON body.");
        const body = JSON.parse(init.body) as { enabled: boolean; revision: number };
        expect(body.revision).toBe(1);
        enabled = body.enabled;
        revision = 2;
        refreshFails = true;
        return Promise.resolve(jsonResponse({ timer: {
          id: "timer-1", name: "Greeting timer", enabled, messageText: "Hello there!", chatTarget: "source_only",
          trigger: { type: "interval", live: { minutes: 30 } }, revision, nextRunAt: null, nextRunState: null,
          lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
        } }));
      }
      if (url.pathname.endsWith("/timers")) {
        timerReads += 1;
        if (timerReads > 1 && refreshFails) return Promise.resolve(jsonResponse({ error: "temporarily unavailable" }, 503));
        return Promise.resolve(jsonResponse({ timers: [{
          id: "timer-1", name: "Greeting timer", enabled, messageText: "Hello there!", chatTarget: "source_only",
          trigger: { type: "interval", live: { minutes: 30 } }, revision, nextRunAt: null, nextRunState: null,
          lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(
      <UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>,
      {},
      { gcTime: 600_000, staleTime: 600_000 },
    );
    fireEvent.click(await screen.findByRole("switch", { name: "Greeting timer: Enabled" }));

    expect(await within(document.querySelector(".timer-list") as HTMLElement).findByRole("switch", { name: "Greeting timer: Disabled" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Timers could not be loaded.")).toBeInTheDocument());
    expect(timerReads).toBeGreaterThan(1);
    expect(queryClient.getQueryData<{ timers: { enabled: boolean; revision: number }[] }>(moduleQueryKey("channel-a", "timers", "panel"))?.timers[0])
      .toMatchObject({ enabled: false, revision: 2 });
    const retryButton = screen.getByRole("button", { name: /Retry|Erneut versuchen/u });
    refreshFails = false;
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByText("Timers could not be loaded.")).not.toBeInTheDocument());
    expect(within(document.querySelector(".timer-list") as HTMLElement).getByRole("switch", { name: "Greeting timer: Disabled" })).toBeInTheDocument();
    expect(timerReads).toBeGreaterThan(2);
  });

  it("reloads the timer from the server after the automatic conflict refresh fails", async () => {
    const originalTimer: Timer = {
      id: "timer-conflict", name: "Original timer", enabled: true, messageText: "Hello", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    const updatedTimer = { ...originalTimer, name: "Updated on the server", revision: 2 };
    let currentTimer = originalTimer;
    let timerReads = 0;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/timers/timer-conflict") && method === "PATCH") {
        currentTimer = updatedTimer;
        return Promise.resolve(jsonResponse({ error: "timer_conflict" }, 409));
      }
      if (url.pathname.endsWith("/timers")) {
        timerReads += 1;
        if (timerReads === 2) return Promise.resolve(jsonResponse({ error: "temporarily unavailable" }, 503));
        return Promise.resolve(jsonResponse({ timers: [currentTimer] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>, {}, { staleTime: 60_000 });
    const nameField = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(nameField, { target: { value: "Rejected draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Updated on the server"));
    expect(timerReads).toBeGreaterThan(2);
  });

  it("keeps the create action visible, disabled, and explained for operators", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    expect(toolbarButton("Create timer")).toBeDisabled();
    expect(document.querySelector(".list-toolbar__reason")).toHaveTextContent("Only broadcasters and managers can edit timers.");
  });

  it("shows timer field errors after an invalid create attempt", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    fireEvent.click(toolbarButton("Create timer"));
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));

    expect(await screen.findByText("Enter a name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a message.")).toHaveAttribute("role", "alert");
  });

  it("disables stream-start fields and timer switches while a save is pending", async () => {
    const timer: Timer = {
      id: "timer-stream-start", name: "Stream reminder", enabled: true, messageText: "Hello", chatTarget: "source_only",
      trigger: { type: "stream_start", minutes: 10 }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    let finishPatch: ((response: Response) => void) | undefined;
    let currentTimer = timer;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/timers") && method === "GET") return Promise.resolve(jsonResponse({ timers: [currentTimer] }));
      if (url.pathname.endsWith("/timers/timer-stream-start") && method === "PATCH") {
        return new Promise<Response>((resolve) => { finishPatch = resolve; });
      }
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    const nameField = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(nameField, { target: { value: "Updated reminder" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(finishPatch).toBeDefined());
    expect(screen.getByRole("spinbutton", { name: "Minutes" })).toBeDisabled();
    for (const toggle of screen.getAllByRole("switch", { name: "Stream reminder: Enabled" })) expect(toggle).toBeDisabled();

    currentTimer = { ...timer, name: "Updated reminder", revision: 2 };
    finishPatch?.(jsonResponse({ timer: currentTimer }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Updated reminder"));
  });

  it("prevents editing a timer while its enablement update is pending", async () => {
    const timer: Timer = {
      id: "timer-toggle", name: "Enablement check", enabled: true, messageText: "Hello", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    let finishToggle: ((response: Response) => void) | undefined;
    let currentTimer = timer;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/timers/timer-toggle/enabled") && method === "PATCH") {
        return new Promise<Response>((resolve) => { finishToggle = resolve; });
      }
      if (url.pathname.endsWith("/timers") && method === "GET") return Promise.resolve(jsonResponse({ timers: [currentTimer] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    const nameField = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(within(document.querySelector(".timer-list") as HTMLElement)
      .getByRole("switch", { name: "Enablement check: Enabled" }));

    await waitFor(() => expect(finishToggle).toBeDefined());
    expect(nameField).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(nameField).toHaveValue("Enablement check");

    currentTimer = { ...timer, enabled: false, revision: 2 };
    finishToggle?.(jsonResponse({ timer: currentTimer }));
    await waitFor(() => expect(screen.getAllByRole("switch", { name: "Enablement check: Disabled" }).length).toBeGreaterThan(0));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Enablement check");
    expect(screen.queryByText("This timer has changed. Reload the current version before continuing.")).not.toBeInTheDocument();
  });

  it("refreshes a timer preview after a successful panel refresh with the same message", async () => {
    const originalTimer: Timer = {
      id: "timer-preview", name: "Preview timer", enabled: true, messageText: "{text.welcome}", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    let currentTimer = originalTimer;
    let previewCalls = 0;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/template-preview")) {
        previewCalls += 1;
        return Promise.resolve(jsonResponse({ text: previewCalls === 1 ? "Resolved welcome message" : "Refreshed welcome message", diagnostics: [] }));
      }
      if (url.pathname.endsWith("/timers/timer-preview/enabled") && method === "PATCH") {
        currentTimer = { ...currentTimer, enabled: false, revision: 2 };
        return Promise.resolve(jsonResponse({ timer: currentTimer }));
      }
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [currentTimer] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    await screen.findByRole("textbox", { name: "Message" });
    const preview = document.querySelector(".ui-template-text-field__preview");
    if (!(preview instanceof HTMLElement)) throw new Error("The timer preview is missing.");
    const previewStatus = preview.querySelector(".timer-editor__preview-status");
    expect(previewStatus?.parentElement).toHaveClass("ui-template-text-field__preview-header");
    await within(preview).findByText("Resolved welcome message");
    expect(previewCalls).toBe(1);

    fireEvent.click(within(document.querySelector(".timer-list") as HTMLElement)
      .getByRole("switch", { name: "Preview timer: Enabled" }));

    await waitFor(() => expect(within(document.querySelector(".timer-list") as HTMLElement)
      .getByRole("switch", { name: "Preview timer: Disabled" })).toBeInTheDocument());
    await within(preview).findByText("Refreshed welcome message");
    expect(previewCalls).toBe(2);
  });

  it("refreshes a nested text block preview after panel data refresh", async () => {
    const timer: Timer = {
      id: "timer-dependency-preview", name: "Dependency preview", enabled: true, messageText: "{text.welcome}", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    let greetingText = "old";
    let previewCalls = 0;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/template-preview")) {
        previewCalls += 1;
        return Promise.resolve(jsonResponse({ text: `Hello ${greetingText}`, diagnostics: [] }));
      }
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [timer] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    await screen.findByRole("textbox", { name: "Message" });
    const preview = document.querySelector(".ui-template-text-field__preview");
    if (!(preview instanceof HTMLElement)) throw new Error("The timer preview is missing.");
    await within(preview).findByText("Hello old");
    expect(previewCalls).toBe(1);

    greetingText = "refreshed";
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: moduleQueryKey("channel-a", "timers", "panel"), exact: true });
    });

    await within(preview).findByText("Hello refreshed");
    expect(previewCalls).toBe(2);
  });

  it("refreshes a sun-conditioned timer preview after panel data refresh", async () => {
    const timer: Timer = {
      id: "timer-sun-preview", name: "Sun preview", enabled: true, messageText: "{text.sun_greeting}", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    const sunGreeting = {
      name: "sun_greeting", revision: 1, games: [],
      variants: [
        { id: "day", conditions: { "sun.phase": "day" }, texts: ["Day greeting"] },
        { id: "night", conditions: { "sun.phase": "night" }, texts: ["Night greeting"] },
        { id: "default", conditions: {}, texts: ["Fallback greeting"] },
      ],
    };
    let sunPhase: "day" | "night" = "day";
    const sunPreviewText: Record<"day" | "night", string> = { day: "Day greeting", night: "Night greeting" };
    let previewCalls = 0;
    let resolveNightPreview: ((response: Response) => void) | null = null;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/template-preview")) {
        previewCalls += 1;
        if (sunPhase === "night") return new Promise<Response>((resolve) => { resolveNightPreview = resolve; });
        return Promise.resolve(jsonResponse({ text: sunPreviewText[sunPhase], diagnostics: [] }));
      }
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [timer] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/modules/text_library/library")) return Promise.resolve(jsonResponse({ blocks: [sunGreeting] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    await screen.findByRole("textbox", { name: "Message" });
    const preview = document.querySelector(".ui-template-text-field__preview");
    if (!(preview instanceof HTMLElement)) throw new Error("The timer preview is missing.");
    await within(preview).findByText("Day greeting");
    expect(previewCalls).toBe(1);
    expect(fetcher.mock.calls.filter(([input]) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      return url.pathname.endsWith("/modules/text_library/library");
    })).toHaveLength(0);

    sunPhase = "night";
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: moduleQueryKey("channel-a", "timers", "panel"), exact: true });
    });

    await waitFor(() => expect(previewCalls).toBe(2));
    expect(within(preview).getByText("Day greeting")).toBeInTheDocument();
    await act(async () => {
      resolveNightPreview?.(jsonResponse({ text: "Night greeting", diagnostics: [] }));
      await Promise.resolve();
    });
    await within(preview).findByText("Night greeting");
    expect(previewCalls).toBe(2);
  });

  it("shows the full expanded text without clipping once a delayed preview arrives", async () => {
    const timer: Timer = {
      id: "timer-delayed-preview", name: "Delayed preview", enabled: true, messageText: "{text.sun_greeting}", chatTarget: "source_only",
      trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
      lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
    };
    const expandedMessage = "Night greeting ".repeat(30);
    let sunPhase: "day" | "night" = "day";
    let resolveNightPreview: ((response: Response) => void) | null = null;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/template-preview")) {
        if (sunPhase === "night") return new Promise<Response>((resolve) => { resolveNightPreview = resolve; });
        return Promise.resolve(jsonResponse({ text: "Day greeting", diagnostics: [] }));
      }
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [timer] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/modules/text_library/library")) return Promise.resolve(jsonResponse({ blocks: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    await screen.findByRole("textbox", { name: "Message" });
    const preview = document.querySelector(".ui-template-text-field__preview");
    if (!(preview instanceof HTMLElement)) throw new Error("The timer preview is missing.");
    const previewMessage = preview.querySelector(".ui-template-text-field__preview-message");
    if (!(previewMessage instanceof HTMLElement)) throw new Error("The timer preview message is missing.");
    await within(preview).findByText("Day greeting");

    sunPhase = "night";
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: moduleQueryKey("channel-a", "timers", "panel"), exact: true });
    });
    await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      return url.pathname.endsWith("/template-preview");
    })).toHaveLength(2));
    expect(within(preview).getByText("Day greeting")).toBeInTheDocument();

    await act(async () => {
      resolveNightPreview?.(jsonResponse({ text: expandedMessage, diagnostics: [] }));
      await Promise.resolve();
    });
    await waitFor(() => expect(previewMessage.querySelector(".ui-template-text-field__preview-text")?.textContent).toBe(expandedMessage));
    expect(previewMessage).toHaveAttribute("title", `Bot: ${expandedMessage}`);
    expect(getComputedStyle(previewMessage).overflowY).not.toMatch(/auto|scroll|hidden/);
    expect(previewMessage.scrollHeight).toBeLessThanOrEqual(previewMessage.clientHeight + 1);
  });

  it("shows timer details as a read-only property list for operators", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [{
        id: "timer-1", name: "Greeting timer", enabled: true, messageText: "Hello there!", chatTarget: "source_only",
        trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunState: null,
        lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
      }] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    expect(await screen.findByText("Greeting timer")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".timer-editor__properties")).toBeInTheDocument());
    expect(document.querySelector(".timer-editor__properties")).toHaveTextContent("Hello there!");
    expect(document.querySelector(".page-header__lock")).toHaveTextContent("Only broadcasters and managers can edit timers.");
    expect(document.querySelectorAll(".page-header__lock")).toHaveLength(1);
    expect(document.querySelector(".timer-editor .lock-reason")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
    expect(deleteItem).toHaveAccessibleDescription("Only broadcasters and managers may delete.");
  });

  it("summarises interval parts and the next run state per language", () => {
    const timer = {
      trigger: { type: "interval", live: { minutes: 20, minimumMessages: 10 }, offline: { minutes: 60, minimumMessages: 5 } },
    } as unknown as Timer;
    const data = { sources: [] } as unknown as TimersPanelData;
    const de = timersTexts("de");
    const en = timersTexts("en");
    expect(triggerDetail(timer, data, de, "de")).toBe("Live alle 20 Min. · ab 10 Nachrichten · Offline alle 60 Min. · ab 5 Nachrichten");
    expect(triggerDetail(timer, data, en, "en")).toBe("Live every 20 min · after 10 messages · Offline every 60 min · after 5 messages");
    const liveOnly = { trigger: { type: "interval", live: { minutes: 20 } } } as unknown as Timer;
    expect(triggerDetail(liveOnly, data, de, "de")).toBe("Live alle 20 Min. · Offline aus");
    expect(triggerDetail(liveOnly, data, en, "en")).toBe("Live every 20 min · Offline off");
    expect(nextRunLabel({ nextRunState: "live" }, de)).toBe("Nächster Lauf (live)");
    expect(nextRunLabel({ nextRunState: "offline" }, de)).toBe("Nächster Lauf (offline)");
    expect(nextRunLabel({ nextRunState: "live" }, en)).toBe("Next run (live)");
    expect(nextRunLabel({ nextRunState: "offline" }, en)).toBe("Next run (offline)");
    expect(nextRunLabel({ nextRunState: null }, en)).toBe("Next run");
    expect(de.afterMessages(1)).toBe("ab 1 Nachricht");
    expect(en.afterMessages(1)).toBe("after 1 message");
    expect(en.characterCount(1)).toBe("1 character");
  });
});
