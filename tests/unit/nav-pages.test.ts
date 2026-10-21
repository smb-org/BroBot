import { describe, expect, it } from "vitest";

import type { ChannelRole } from "../../src/contracts/values";
import { dashboardNavigationGroups, DASHBOARD_NAVIGATION_CATEGORIES, MODULE_NAVIGATION_CATEGORY_GROUPS, visibleModuleNavigationIds } from "../../src/dashboard/nav-pages";
import { dashboardTexts } from "../../src/dashboard/locale";
import { dashboardModeForRoute, parseDashboardRoute, routeForDashboardMode, routeForSelectedChannel, type DashboardRoute } from "../../src/dashboard/router";
import { moduleName } from "../../src/dashboard/module-labels";
import { MODULES } from "../../src/modules/registry";

const navigationFor = (moduleStates: { id: string; enabled: boolean }[], role: ChannelRole | null = "manager") =>
  dashboardNavigationGroups(
    { isPlatformAdmin: true },
    "channel-a",
    dashboardTexts("en"),
    MODULES,
    moduleStates,
    role,
    "en",
    (moduleId) => moduleName(moduleId, "en"),
  );

describe("dashboard navigation", () => {
  it("maps every module navigation category to one of the six shell groups", () => {
    expect(Object.values(MODULE_NAVIGATION_CATEGORY_GROUPS)).toEqual(DASHBOARD_NAVIGATION_CATEGORIES);
    expect(new Set(Object.values(MODULE_NAVIGATION_CATEGORY_GROUPS))).toEqual(new Set(DASHBOARD_NAVIGATION_CATEGORIES));

    const groups = navigationFor(MODULES.map(({ id }) => ({ id, enabled: true })));
    for (const module of MODULES) {
      const entry = groups.flatMap(({ entries }) => entries).find((candidate) => candidate.moduleId === module.id);
      if (module.id === "channel_events") {
        expect(entry, "the dedicated channel-events history page replaces the generic mandatory module link").toBeUndefined();
        continue;
      }
      expect(entry?.category, `${module.id} must have one known navigation group`).toBe(MODULE_NAVIGATION_CATEGORY_GROUPS[module.navigationCategory]);
    }
  });

  it("places the channel-events history page directly before the audit log in admin", () => {
    const groups = navigationFor(MODULES.map(({ id }) => ({ id, enabled: true })));
    const admin = groups.find(({ category }) => category === "admin");
    const entries = admin?.entries ?? [];
    const channelEventsIndex = entries.findIndex(({ pageId }) => pageId === "events");
    expect(entries[channelEventsIndex]).toMatchObject({ pageId: "events", label: "Channel events" });
    expect(entries[channelEventsIndex + 1]).toMatchObject({ pageId: "audit", label: "Log" });
  });

  it("routes Kanalereignisse through the dedicated admin history page", () => {
    const groups = dashboardNavigationGroups(
      { isPlatformAdmin: true },
      "channel-a",
      dashboardTexts("de"),
      MODULES,
      MODULES.map(({ id }) => ({ id, enabled: true })),
      "manager",
      "de",
      (moduleId) => moduleName(moduleId, "de"),
    );
    const entries = groups.flatMap(({ entries: groupEntries }) => groupEntries);
    expect(entries.find(({ pageId }) => pageId === "events")).toMatchObject({ category: "admin", label: "Kanalereignisse" });
    expect(entries.some(({ moduleId }) => moduleId === "channel_events")).toBe(false);
  });

  it("places Ort & Wetter in Setup data and keeps channel defaults in admin System", () => {
    const groups = navigationFor(MODULES.map(({ id }) => ({ id, enabled: true })));
    const entries = groups.flatMap(({ entries: groupEntries }) => groupEntries);
    expect(entries.find(({ pageId }) => pageId === "location-weather")).toMatchObject({
      category: "data",
      area: "setup",
      route: { kind: "channel", channelId: "channel-a", section: "location-weather" },
    });
    expect(entries.find(({ pageId }) => pageId === "system")).toMatchObject({
      category: "admin",
      area: "setup",
      route: { kind: "channel", channelId: "channel-a", section: "system" },
    });
    expect(parseDashboardRoute("/channels/channel-a/location-weather")).toEqual({
      kind: "channel", channelId: "channel-a", section: "location-weather",
    });
  });

  it("keeps inactive modules out of the sidebar while leaving them searchable", () => {
    const states = MODULES.map(({ id }) => ({ id, enabled: id !== "timers" }));
    const groups = navigationFor(states);
    const timer = groups.flatMap(({ entries }) => entries).find(({ moduleId }) => moduleId === "timers");

    expect(timer).toMatchObject({ moduleId: "timers", label: "Timers", sidebarVisible: false });
    expect(groups.flatMap(({ entries }) => entries.filter((entry) => entry.sidebarVisible)).some(({ moduleId }) => moduleId === "timers")).toBe(false);
    expect(visibleModuleNavigationIds(states, "manager")).not.toContain("timers");
  });

  it("hides modules while their broadcaster permission status is unknown (protects=unknown scope metadata cannot make an enabled module appear active in channel navigation; fails_when=the module link is visible before scope status is known; no_claim=whether the module is visible after scope lookup succeeds)", () => {
    const states = [{ id: "points", enabled: true, broadcasterScopeMetadataUnknown: true as const }];
    const groups = navigationFor(states);
    const points = groups.flatMap(({ entries }) => entries).find(({ moduleId }) => moduleId === "points");

    expect(points).toMatchObject({ moduleId: "points", sidebarVisible: false });
    expect(visibleModuleNavigationIds(states, "manager")).not.toContain("points");
  });

  it("groups navigation entries in the requested order", () => {
    const groups = navigationFor(MODULES.map(({ id }) => ({ id, enabled: true })));
    expect(groups.map(({ category }) => category)).toEqual([...DASHBOARD_NAVIGATION_CATEGORIES]);
  });

  it("treats only overview routes as Live", () => {
    const liveRoutes: DashboardRoute[] = [
      { kind: "overview" },
      { kind: "channel", channelId: "channel-a", section: "overview" },
    ];
    const setupRoutes: DashboardRoute[] = [
      { kind: "channel", channelId: "channel-a", section: "system" },
      { kind: "channel", channelId: "channel-a", section: "events" },
      { kind: "channel", channelId: "channel-a", section: "audit" },
      { kind: "module", channelId: "channel-a", moduleId: "timers" },
      { kind: "platform" },
    ];

    for (const route of liveRoutes) expect(dashboardModeForRoute(route)).toBe("live");
    for (const route of setupRoutes) expect(dashboardModeForRoute(route)).toBe("setup");
  });

  it("keeps platform setup reachable when an admin has no released channels", () => {
    expect(routeForDashboardMode({ kind: "overview" }, "setup", null, true)).toEqual({ kind: "platform" });
    expect(routeForDashboardMode({ kind: "overview" }, "setup", null, false)).toEqual({ kind: "overview" });
  });

  it("keeps channel switching in the current Live or Setup area", () => {
    expect(routeForSelectedChannel({ kind: "overview" }, "channel-b")).toEqual({
      kind: "channel", channelId: "channel-b", section: "overview",
    });
    expect(routeForSelectedChannel({ kind: "module", channelId: "channel-a", moduleId: "timers" }, "channel-b")).toEqual({
      kind: "module", channelId: "channel-b", moduleId: "timers",
    });
    expect(routeForSelectedChannel({ kind: "channel", channelId: "channel-a", section: "audit" }, "channel-b")).toEqual({
      kind: "channel", channelId: "channel-b", section: "audit",
    });
  });
});
