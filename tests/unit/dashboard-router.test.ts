import { describe, expect, it } from "vitest";

import { dashboardRouteFocusKey, parseDashboardRoute } from "../../src/dashboard/router";

describe("dashboard route focus identity", () => {
  it("ignores event filters and selected overlay state within the same page", () => {
    expect(dashboardRouteFocusKey(parseDashboardRoute("/channels/a/events", "?actor=first")))
      .toBe(dashboardRouteFocusKey(parseDashboardRoute("/channels/a/events", "?actor=second")));
    expect(dashboardRouteFocusKey(parseDashboardRoute("/channels/a/overlays", "?overlay=first")))
      .toBe(dashboardRouteFocusKey(parseDashboardRoute("/channels/a/overlays", "?overlay=second")));
  });

  it("changes when navigation enters a different page or overlay editor", () => {
    expect(dashboardRouteFocusKey(parseDashboardRoute("/channels/a/members")))
      .not.toBe(dashboardRouteFocusKey(parseDashboardRoute("/channels/a/events")));
    expect(dashboardRouteFocusKey(parseDashboardRoute("/channels/a/overlays")))
      .not.toBe(dashboardRouteFocusKey(parseDashboardRoute("/channels/a/overlays/editor")));
  });
});
