import { describe, expect, it } from "vitest";

import { countStatisticsEmotes, statisticsWindowStart } from "../../src/modules/statistics/domain";

describe("statistics window domain", () => {
  it("aligns five-minute windows to UTC epoch multiples of 300 s", () => {
    expect(statisticsWindowStart("2026-10-25T12:07:29.999Z")).toBe(Date.parse("2026-10-25T12:05:00.000Z"));
    expect(statisticsWindowStart("2026-10-25T12:09:59.999Z")).toBe(Date.parse("2026-10-25T12:05:00.000Z"));
    expect(statisticsWindowStart("2026-10-25T12:10:00.000Z")).toBe(Date.parse("2026-10-25T12:10:00.000Z"));
    expect((statisticsWindowStart("2026-10-25T12:03:41.000Z") ?? 1) % 300_000).toBe(0);
  });

  it("returns no window for an invalid timestamp", () => {
    expect(statisticsWindowStart("not-a-date")).toBeNull();
  });

  it("counts emote fragments without counting text fragments", () => {
    expect(countStatisticsEmotes({
      message: {
        fragments: [
          { type: "text", text: "hello" },
          { type: "emote", text: "Kappa", emote: { id: "25", emote_set_id: "0", owner_id: "1" } },
          { type: "emote", text: "Pog", emote: { id: "88", emote_set_id: "0", owner_id: "1" } },
        ],
      },
    })).toBe(2);
    expect(countStatisticsEmotes({ message: { fragments: [{ type: "text", text: "hello" }] } })).toBe(0);
  });
});
