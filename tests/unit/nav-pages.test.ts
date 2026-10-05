import { describe, expect, it } from "vitest";

import { enabledModuleNavigationGroups } from "../../src/dashboard/nav-pages";
import { MODULES } from "../../src/modules/registry";

describe("module sidebar categories", () => {
  it("groups enabled modules by their contract categories and keeps custom entries", () => {
    const groups = enabledModuleNavigationGroups(
      MODULES,
      MODULES.map(({ id }) => ({ id, enabled: true })),
      "channel-a",
      "en",
      (moduleId) => `Generic ${moduleId}`,
    );

    expect(groups.map(({ category, entries }) => [category, entries.map(({ moduleId }) => moduleId)])).toEqual([
      ["chat", ["text_commands", "faq", "text_library", "timers"]],
      ["interaction", ["chat_voting", "votekick"]],
      ["data", ["sun", "moon", "weather", "currency", "api_source", "belabox"]],
      ["twitch", ["channel_events", "ads", "raid", "clips"]],
    ]);
    expect(groups[0]?.entries[0]).toMatchObject({ id: "text_commands", label: "Generic text_commands", iconKind: null });
    expect(groups[0]?.entries[1]).toMatchObject({ id: "faq:faq", label: "FAQ & Auto replies", iconKind: "faq" });
    expect(groups[0]?.entries[1]?.route).toEqual({ kind: "module", channelId: "channel-a", moduleId: "faq" });
  });

  it("hides disabled modules and modules blocked by missing scopes", () => {
    const groups = enabledModuleNavigationGroups(
      MODULES,
      MODULES.map(({ id }) => ({
        id,
        enabled: id !== "faq",
        ...(id === "ads" ? { missingBroadcasterScopes: ["channel:read:ads"] } : {}),
      })),
      "channel-a",
      "de",
      (moduleId) => `Generic ${moduleId}`,
    );
    const moduleIds = groups.flatMap(({ entries }) => entries.map(({ moduleId }) => moduleId));

    expect(moduleIds).not.toContain("faq");
    expect(moduleIds).not.toContain("ads");
    expect(moduleIds).toContain("timers");
  });
});
