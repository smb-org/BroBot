import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { EventsPage } from "../../src/dashboard/events/EventsPage";
import { emptyEventFilter } from "../../src/dashboard/events/model";
import { loadedState } from "../../src/dashboard/load-state";
import type { PanelEventEntry, PanelEventsResponse } from "../../src/panel-contract";

const entry = (overrides: Partial<PanelEventEntry>): PanelEventEntry => ({
  eventId: "event-1",
  createdAt: "2026-09-22T10:00:00.000Z",
  moduleId: "host",
  // Distinct per entry by default -- entries sharing a `triggerId` collapse
  // into one group (`eventGroups`), and only the group's representative
  // renders as a row. Callers that want to exercise grouping override this.
  triggerId: `trigger-${overrides.eventId ?? "event-1"}`,
  code: "host.chat.failed",
  detail: "{}",
  actorUserId: null,
  actorLogin: null,
  actorDisplayName: null,
  ...overrides,
});

const renderPage = (entries: readonly PanelEventEntry[]) => {
  const response: PanelEventsResponse = { entries: [...entries], nextCursor: null };
  return render(
    <UiProvider>
      <EventsPage
        channelId="kanal-a"
        eventsState={loadedState(response)}
        filters={emptyEventFilter}
        moduleOptions={[]}
        onFiltersChange={() => undefined}
        onRefreshFirstPage={() => Promise.resolve()}
        onNextPage={() => undefined}
        loadingNextPage={false}
      />
    </UiProvider>,
  );
};

/** The trigger's accessible name is "Ursache anzeigen: <row label>" (DE) or
 *  "Show cause: <row label>" (EN) -- tests that don't care about the exact
 *  label match on the language-fixed prefix. */
const causeButtonName = /^(Ursache anzeigen|Show cause):/;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // `dashboardLanguage()` reads `navigator.language`; reset it to the suite
  // default (`tests/setup.ts`) so an English test doesn't leak into the next.
  Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
});

describe("EventsPage failure cause icon", () => {
  it("shows the cause icon only on warning/error rows whose diagnostic detail carries a cause", () => {
    renderPage([
      entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" }),
      entry({ eventId: "no-cause", code: "host.action.failed", detail: "{}" }),
      // An info-tone row with a `reason` key still gets no icon -- the tone
      // guard runs before the cause lookup, not just when there's nothing
      // to show.
      entry({ eventId: "info-row", code: "channel_events.chat.sub", detail: "{\"tier\":\"1000\",\"reason\":\"rate_limited\"}" }),
    ]);

    expect(screen.getAllByRole("button", { name: causeButtonName })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ursache anzeigen: Chat-Nachricht fehlgeschlagen" })).toBeInTheDocument();
  });

  it("shows the localized cause in a popover on hover, without opening the inspector", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
    expect(screen.queryByText("Vorgang")).not.toBeInTheDocument();
  });

  it("shows the cause on keyboard focus", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.focus(trigger);

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
  });

  it("opens on click, the same way it does on tap", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.click(trigger);

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
  });

  it("dismisses on Escape", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.focus(trigger);
    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Escape", code: "Escape" });
    await waitFor(() => { expect(screen.queryByText("Twitch-Abklingzeit aktiv")).not.toBeInTheDocument(); });
  });

  it("stays open while the pointer moves from the trigger to the dropdown", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);
    const content = await screen.findByText("Twitch-Abklingzeit aktiv");
    // jsdom never resolves Mantine's open transition, so the dropdown stays
    // `display: none` inline and `getByRole("tooltip")` (which filters
    // hidden elements) can't see it -- reach it via the text node instead.
    const dropdown = content.closest("[role='tooltip']");
    if (dropdown === null) throw new Error("dropdown missing");

    // Leaving the trigger for the dropdown before the close delay elapses
    // must not close it -- this is the pointer-transition case a plain
    // `onMouseLeave` on the trigger alone gets wrong.
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(dropdown);
    expect(screen.getByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

    fireEvent.mouseLeave(dropdown);
    await waitFor(() => { expect(screen.queryByText("Twitch-Abklingzeit aktiv")).not.toBeInTheDocument(); });
  });

  it("stays open when the mouse leaves while the trigger still has keyboard focus", () => {
    vi.useFakeTimers();
    try {
      renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

      const trigger = screen.getByRole("button", { name: causeButtonName });
      // Hover and focus together, e.g. a mouse click that both hovers and
      // focuses the button -- then only the hover ends.
      fireEvent.mouseEnter(trigger);
      fireEvent.focus(trigger);
      // Mantine mounts the dropdown a tick after `opened` flips, via its own
      // (now fake) timer -- advance past it before the content is queryable.
      vi.advanceTimersByTime(50);
      expect(screen.getByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

      fireEvent.mouseLeave(trigger);
      // Past the close delay: a mouseleave-only close would have fired by
      // now, but focus is still active, so it must stay open.
      vi.advanceTimersByTime(1000);
      expect(screen.getByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

      // Losing focus too, with hover already gone, closes it -- checked via
      // `aria-describedby` (this component's own `opened` state, updated
      // synchronously) rather than the dropdown's removal from the DOM:
      // Mantine's exit transition never resolves in jsdom (no real
      // `transitionend`), so the node lingers there regardless.
      fireEvent.blur(trigger);
      expect(trigger).not.toHaveAttribute("aria-describedby");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its pending close timer on unmount instead of leaving it running", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    try {
      const { unmount } = renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

      const trigger = screen.getByRole("button", { name: causeButtonName });
      fireEvent.mouseEnter(trigger);
      vi.advanceTimersByTime(50);
      expect(screen.getByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

      // A hover-out schedules exactly one delayed close.
      setTimeoutSpy.mockClear();
      fireEvent.mouseLeave(trigger);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      const closeTimerId: unknown = setTimeoutSpy.mock.results[0]?.value;

      // Unmounting before it fires must cancel that specific timer, not
      // leave it running against an unmounted component. (React 18+ no
      // longer warns to console.error on a state update after unmount, so
      // that can't be used to detect a missing cleanup here -- this checks
      // the timer directly instead.)
      unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(closeTimerId);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not open the inspector when the cause icon is clicked", () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.click(trigger);

    expect(screen.queryByText("Vorgang")).not.toBeInTheDocument();
    const row = trigger.closest("tr");
    expect(row).toHaveAttribute("aria-selected", "false");
  });

  it("renders a legacy German reason value from before issue #191's rename correctly", () => {
    // Rows persisted before the rename still carry the old value for up to
    // 14 days (event log retention) -- `eventDetail` migrates it before any
    // formatter sees it.
    renderPage([entry({ eventId: "legacy", moduleId: "raid", code: "raid.invalid", detail: "{\"reason\":\"ziel_ungueltig\"}" })]);

    expect(screen.getByText("Raid verworfen: Ziel ungültig")).toBeInTheDocument();
    expect(screen.queryByText(/ziel_ungueltig/)).not.toBeInTheDocument();
  });

  it("normalizes a legacy reason in the inspector's technical details too, not just the row", () => {
    renderPage([entry({ eventId: "legacy", moduleId: "raid", code: "raid.invalid", detail: "{\"reason\":\"ziel_ungueltig\"}" })]);

    fireEvent.click(screen.getByText("Raid verworfen: Ziel ungültig").closest("tr") as HTMLElement);
    const technicalDetails = document.querySelector(".event-detail-json");
    expect(technicalDetails).not.toBeNull();
    expect(technicalDetails?.textContent).toContain("target_invalid");
    expect(technicalDetails?.textContent).not.toContain("ziel_ungueltig");
  });

  it("still falls back to the raw stored string in technical details for malformed detail JSON", () => {
    renderPage([entry({ eventId: "malformed", moduleId: "host", code: "host.action.failed", detail: "not json" })]);

    fireEvent.click(screen.getByText("Aktion fehlgeschlagen").closest("tr") as HTMLElement);
    const technicalDetails = document.querySelector(".event-detail-json");
    expect(technicalDetails?.textContent).toBe("not json");
  });

  it("leaves a moderation event's free-text reason untouched even when it equals an old legacy value", () => {
    // "abgeschaltet" is only a legacy machine-code value for ads.skipped,
    // raid.invalid, and shoutout.suppressed (issue #191) -- a moderator's
    // own ban reason happening to be that word is unrelated content and
    // must not be rewritten to "disabled".
    renderPage([entry({
      eventId: "moderation-ban", moduleId: "channel_events", code: "channel_events.moderation.ban",
      detail: "{\"person\":\"chattyfan\",\"moderator\":\"mod1\",\"reason\":\"abgeschaltet\"}",
    })]);

    expect(screen.getByText("chattyfan gebannt von mod1: abgeschaltet")).toBeInTheDocument();
    expect(screen.queryByText(/disabled/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("chattyfan gebannt von mod1: abgeschaltet").closest("tr") as HTMLElement);
    const technicalDetails = document.querySelector(".event-detail-json");
    expect(technicalDetails?.textContent).toContain("abgeschaltet");
    expect(technicalDetails?.textContent).not.toContain("disabled");
  });

  it("hides the icon when the row's own event text already spells the cause out", () => {
    renderPage([
      // "ads.commercial.failed" already renders "... Twitch hat den Start
      // abgelehnt" inline -- the popover would just repeat it.
      entry({ eventId: "spelled-out", moduleId: "ads", code: "ads.commercial.failed", detail: "{\"reason\":\"twitch_error\"}" }),
      // "host.clip.failed" stays generic ("Clip fehlgeschlagen") regardless
      // of the reason, so the icon still earns its place.
      entry({ eventId: "still-hidden", moduleId: "host", code: "host.clip.failed", detail: "{\"reason\":\"twitch_error\"}" }),
    ]);

    expect(screen.getAllByRole("button", { name: causeButtonName })).toHaveLength(1);
    expect(screen.getByText(/Werbeeinblendung nicht gestartet: Twitch hat den Start abgelehnt/)).toBeInTheDocument();
  });

  it("hides the icon for host.announcement.failed and uses the shared shoutout catalog wording in the row", () => {
    renderPage([entry({
      eventId: "announcement-failed", moduleId: "host", code: "host.announcement.failed",
      detail: "{\"reason\":\"not_moderator\",\"outcome\":\"not_sent\"}",
    })]);

    expect(screen.queryByRole("button", { name: causeButtonName })).not.toBeInTheDocument();
    expect(screen.getByText("Ankündigung nicht möglich (Der Bot ist kein Moderator in diesem Kanal) — nicht gesendet")).toBeInTheDocument();
  });

  it("localizes an uncatalogued http_<status> reason in the row instead of leaking it raw (host.announcement.failed)", () => {
    renderPage([entry({
      eventId: "announcement-http", moduleId: "host", code: "host.announcement.failed",
      detail: "{\"reason\":\"http_500\",\"outcome\":\"not_sent\"}",
    })]);

    expect(screen.getByText("Ankündigung nicht möglich (Twitch antwortete mit Fehler 500) — nicht gesendet")).toBeInTheDocument();
    expect(screen.queryByText(/http_500/)).not.toBeInTheDocument();
  });

  it("uses the clip catalog's wording, not the shoutout one, for host.clip.failed", async () => {
    renderPage([entry({ eventId: "clip-failed", moduleId: "host", code: "host.clip.failed", detail: "{\"reason\":\"scope_missing\"}" })]);

    const trigger = screen.getByRole("button", { name: "Ursache anzeigen: Clip fehlgeschlagen" });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Berechtigung zum Erstellen von Clips fehlt")).toBeInTheDocument();
    expect(screen.queryByText("Berechtigung zum Senden des Shoutouts fehlt")).not.toBeInTheDocument();
  });

  it("follows the browser language for both the cause text and the trigger's accessible name", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: "Show cause: Chat message failed" });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Twitch cooldown is active")).toBeInTheDocument();
  });

  it("still opens the inspector when the row itself is clicked", () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    const row = trigger.closest("tr");
    if (row === null) throw new Error("row missing");
    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Vorgang")).toBeInTheDocument();
  });
});
