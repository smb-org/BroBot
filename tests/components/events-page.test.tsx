import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EventsPage failure cause icon", () => {
  it("shows the cause icon only on warning/error rows whose diagnostic detail carries a cause", () => {
    const { container } = renderPage([
      entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" }),
      entry({ eventId: "no-cause", code: "host.action.failed", detail: "{}" }),
      entry({ eventId: "info-row", code: "channel_events.chat.sub", detail: "{\"tier\":\"1000\"}" }),
    ]);

    expect(screen.getAllByRole("button", { name: "Ursache anzeigen" })).toHaveLength(1);
    expect(container.querySelectorAll("tr").length).toBeGreaterThan(0);
  });

  it("shows the localized cause in a popover on hover, without opening the inspector", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: "Ursache anzeigen" });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
    expect(screen.queryByText("Vorgang")).not.toBeInTheDocument();
  });

  it("shows the cause on keyboard focus", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: "Ursache anzeigen" });
    fireEvent.focus(trigger);

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
  });

  it("does not open the inspector when the cause icon is clicked", () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: "Ursache anzeigen" });
    fireEvent.click(trigger);

    expect(screen.queryByText("Vorgang")).not.toBeInTheDocument();
    const row = trigger.closest("tr");
    expect(row).toHaveAttribute("aria-selected", "false");
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

    expect(screen.getAllByRole("button", { name: "Ursache anzeigen" })).toHaveLength(1);
    expect(screen.getByText(/Werbeeinblendung nicht gestartet: Twitch hat den Start abgelehnt/)).toBeInTheDocument();
  });

  it("still opens the inspector when the row itself is clicked", () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: "Ursache anzeigen" });
    const row = trigger.closest("tr");
    if (row === null) throw new Error("row missing");
    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Vorgang")).toBeInTheDocument();
  });
});
