import { describe, expect, it } from "vitest";

import { dashboardRoutePath, parseDashboardRoute } from "../../src/dashboard/router";

describe("test area module route round trips", () => {
  it.each(["text_commands", "faq", "chat_voting", "votekick"] as const)(
    "preserves the %s module filter and entry id",
    (moduleId) => {
      const route = { kind: "channel", channelId: "channel-a", section: "test-area", only: { moduleId, entryId: "entry-123" } } as const;
      const path = new URL(dashboardRoutePath(route), "https://example.test");

      expect(parseDashboardRoute(path.pathname, path.search)).toEqual(route);
    },
  );
});
