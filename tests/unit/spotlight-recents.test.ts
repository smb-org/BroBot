import { describe, expect, it } from "vitest";

import { readRecentTargets, rememberRecentTarget, type RecentTargetStorage } from "../../src/dashboard/spotlight-recents";

const createStorage = (): RecentTargetStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
};

describe("Spotlight recent targets", () => {
  it("keeps the most recently visited five targets in order and moves a revisit to the front", () => {
    const storage = createStorage();
    for (let index = 1; index <= 7; index += 1) {
      rememberRecentTarget("viewer-order", "channel-order", `page-${String(index)}`, storage);
    }

    expect(rememberRecentTarget("viewer-order", "channel-order", "page-4", storage)).toEqual([
      "page-4", "page-7", "page-6", "page-5", "page-3",
    ]);
    expect(readRecentTargets("viewer-order", "channel-order", storage)).toHaveLength(5);
  });

  it("scopes records by viewer and channel and ignores malformed or duplicate entries", () => {
    const storage = createStorage();
    rememberRecentTarget("viewer-a", "channel-a", "events", storage);
    rememberRecentTarget("viewer-b", "channel-a", "variables", storage);
    rememberRecentTarget("viewer-a", "channel-b", "members", storage);

    expect(readRecentTargets("viewer-a", "channel-a", storage)).toEqual(["events"]);
    expect(readRecentTargets("viewer-b", "channel-a", storage)).toEqual(["variables"]);
    expect(readRecentTargets("viewer-a", "channel-b", storage)).toEqual(["members"]);

    const key = [...storage.values.keys()].find((value) => value.includes("viewer-a") && value.includes("channel-a"));
    expect(key).toBeDefined();
    storage.values.set(key as string, JSON.stringify(["events", "events", 4, "", "members"]));
    expect(readRecentTargets("viewer-a", "channel-a", storage)).toEqual(["events", "members"]);
  });

  it("keeps working when storage is unavailable or throws", () => {
    const viewer = `viewer-memory-${String(Date.now())}`;
    expect(rememberRecentTarget(viewer, "channel-memory", "events", null)).toEqual(["events"]);
    expect(rememberRecentTarget(viewer, "channel-memory", "modules", null)).toEqual(["modules", "events"]);
    expect(readRecentTargets(viewer, "channel-memory", null)).toEqual(["modules", "events"]);

    const throwingStorage: RecentTargetStorage = {
      getItem: () => { throw new Error("storage denied"); },
      setItem: () => { throw new Error("storage denied"); },
    };
    expect(rememberRecentTarget(viewer, "channel-throwing", "events", throwingStorage)).toEqual(["events"]);
    expect(readRecentTargets(viewer, "channel-throwing", throwingStorage)).toEqual(["events"]);
  });

  it("keeps memory history authoritative when storage reads work but writes fail", () => {
    const viewer = `viewer-write-failure-${String(Date.now())}`;
    const values = new Map<string, string>();
    const storage: RecentTargetStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: () => { throw new Error("storage is read-only"); },
    };
    const key = `brobot-dashboard-spotlight-recent-v1:${encodeURIComponent(viewer)}:channel-write-failure`;
    values.set(key, JSON.stringify(["page-a"]));

    expect(rememberRecentTarget(viewer, "channel-write-failure", "page-b", storage)).toEqual(["page-b", "page-a"]);
    expect(rememberRecentTarget(viewer, "channel-write-failure", "page-c", storage)).toEqual(["page-c", "page-b", "page-a"]);
    expect(readRecentTargets(viewer, "channel-write-failure", storage)).toEqual(["page-c", "page-b", "page-a"]);
  });
});
