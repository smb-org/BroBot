import { describe, expect, it } from "vitest";

import { routeForSelectedChannel } from "../../src/dashboard/router";

describe("test area route channel scoping", () => {
  it("drops a channel-specific entry id when selecting another channel", () => {
    const route = routeForSelectedChannel({
      kind: "channel",
      channelId: "channel-a",
      section: "test-area",
      only: { moduleId: "faq", entryId: "faq-a" },
    }, "channel-b");

    expect(route).toEqual({
      kind: "channel",
      channelId: "channel-b",
      section: "test-area",
      only: { moduleId: "faq" },
    });
  });

  it("preserves the entry id when reselecting the same channel", () => {
    const route = routeForSelectedChannel({
      kind: "channel",
      channelId: "channel-a",
      section: "test-area",
      only: { moduleId: "faq", entryId: "faq-a" },
    }, "channel-a");

    expect(route).toMatchObject({ channelId: "channel-a", only: { moduleId: "faq", entryId: "faq-a" } });
  });
});
