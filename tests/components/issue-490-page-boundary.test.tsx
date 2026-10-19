import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { dashboardTexts } from "../../src/dashboard/locale";
import type * as EventsPageModule from "../../src/dashboard/events/EventsPage";
import { renderWithQuery } from "../query-test-utils";

const testControl = vi.hoisted(() => ({ throwFromEventsPage: false }));

vi.mock("../../src/dashboard/events/EventsPage", async (importOriginal) => {
  const actual = await importOriginal<typeof EventsPageModule>();
  return {
    ...actual,
    EventsPage: (properties: Parameters<typeof actual.EventsPage>[0]) => {
      if (testControl.throwFromEventsPage) throw new Error("Injected events page failure");
      return actual.EventsPage(properties);
    },
  };
});

const channel = {
  channelId: "issue-490-channel",
  login: "issue490",
  displayName: "Issue 490",
  language: "de" as const,
  role: "manager" as const,
  location: null,
  broadcasterConnection: "connected" as const,
  channelBotConsent: "granted" as const,
  bot: { status: "connected" as const, reason: null, updatedAt: "2026-10-19T09:00:00.000Z" },
  botPermissions: null,
  broadcasterPermissions: null,
  moderator: { isModerator: true, checkedAt: "2026-10-19T09:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled" as const, subscriptionId: "issue-490-sub", reason: null, updatedAt: "2026-10-19T09:00:00.000Z" },
  streamState: "offline" as const,
  streamStartedAt: null,
  controls: {
    mute: { active: false, until: null, mode: null },
    pause: { active: false, until: null, mode: null },
  },
  modules: [],
  tokens: {
    botExpiresAt: "2099-10-19T09:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-10-19T09:00:00.000Z",
  },
  lastError: null,
};

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const stubDashboard = (): void => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = input instanceof Request
      ? new URL(input.url)
      : input instanceof URL ? input : new URL(input, window.location.href);
    if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
    if (url.pathname === `/api/channels/${channel.channelId}/events`) return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
    if (url.pathname === `/api/channels/${channel.channelId}/audit-log`) return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
    if (url.pathname === `/api/channels/${channel.channelId}/modules`) return Promise.resolve(jsonResponse({ modules: [] }));
    return Promise.resolve(jsonResponse({}, 404));
  }));
};

afterEach(() => {
  cleanup();
  testControl.throwFromEventsPage = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

it.each(["events", "audit"] as const)("keeps the %s person filter mounted and focused while its query state updates", async (section) => {
  stubDashboard();
  window.history.replaceState({}, "", `/channels/${channel.channelId}/${section}`);
  renderWithQuery(<DashboardApp />);

  const personFilter = await screen.findByRole("textbox", { name: "Person" });
  personFilter.focus();
  fireEvent.change(personFilter, { target: { value: "alice" } });

  await waitFor(() => expect(window.location.search).toContain("actor=alice"), { timeout: 2_000 });
  expect(screen.getByRole("textbox", { name: "Person" })).toBe(personFilter);
  expect(personFilter).toHaveFocus();
});

it("keeps the command palette available when page content throws", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  testControl.throwFromEventsPage = true;
  stubDashboard();
  window.history.replaceState({}, "", `/channels/${channel.channelId}/events`);
  renderWithQuery(<DashboardApp />);

  const texts = dashboardTexts("de");
  expect(await screen.findByText(texts.navigation.pageErrorTitle)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: texts.commandPalette.placeholder }));

  expect(await screen.findByRole("combobox", { name: texts.commandPalette.title })).toBeVisible();
});
