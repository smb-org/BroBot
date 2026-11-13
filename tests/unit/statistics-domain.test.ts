import { describe, expect, it } from "vitest";

import {
  countStatisticsEmotes,
  foldStatisticsWord,
  addStatisticsWordCount,
  calculateStatisticsWordCount,
  statisticsTextFragments,
  statisticsWordsExcluded,
  statisticsWindowStart,
  tokenizeStatisticsWordDetails,
  type StatisticsWordCountValue,
} from "../../src/modules/statistics/domain";

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

  it("folds repeated Unicode letters after compatibility normalization and lowercasing", () => {
    expect(["faaak", "FAAAK", "faak", "fak", "ＡＡＡ", "äää"].map(foldStatisticsWord))
      .toEqual(["fak", "fak", "fak", "fak", "a", "ä"]);
  });

  it("shares stream, total, display and rare-word calculations for one folded word", () => {
    const baseline = new Map<string, StatisticsWordCountValue>();
    const stream = new Map<string, StatisticsWordCountValue>();
    addStatisticsWordCount(baseline, {
      word: "fak", displayWord: "Faaak", count: 3_765, lastSeenAt: "2026-10-25T11:00:00.000Z",
    });
    addStatisticsWordCount(stream, {
      word: "fak", displayWord: "Fak", count: 47, lastSeenAt: "2026-10-25T12:00:00.000Z",
    });

    expect(calculateStatisticsWordCount("FAAAK", baseline, stream, "total", "2026-10-18T00:00:00.000Z"))
      .toMatchObject({ word: "fak", displayWord: "Faaak", streamCount: 47, totalCount: 3_812, count: 3_812, hiddenByRarity: false });
    expect(calculateStatisticsWordCount("fak", baseline, stream, "stream", "2026-10-18T00:00:00.000Z"))
      .toMatchObject({ displayWord: "Fak", streamCount: 47, count: 47 });

    const rare = new Map<string, StatisticsWordCountValue>();
    addStatisticsWordCount(rare, {
      word: "rareword", displayWord: "RareWord", count: 2, lastSeenAt: "2026-10-17T23:59:00.000Z",
    });
    expect(calculateStatisticsWordCount("rareword", rare, new Map(), "total", "2026-10-18T00:00:00.000Z").hiddenByRarity)
      .toBe(true);
  });

  it("keeps the first display spelling while counting emotes with typed words once per message", () => {
    const details = tokenizeStatisticsWordDetails(statisticsTextFragments({
      chatter_user_login: "viewer",
      message: { fragments: [
        { type: "text", text: "KEKW kekw" },
        { type: "emote", text: "KEKW", emote: { id: "25", emote_set_id: "0", owner_id: "1" } },
        { type: "text", text: "Faaak FAak" },
      ] },
    }));

    expect(details.get("kekw")).toEqual({ count: 1, displayWord: "KEKW" });
    expect(details.get("fak")).toEqual({ count: 1, displayWord: "Faaak" });
  });

  it("excludes command messages and known bot logins from word counting", () => {
    expect(statisticsWordsExcluded({
      chatter_user_id: "fictional-viewer-1",
      chatter_user_login: "frostfern",
      chatter_user_name: "Frost Fern",
      message: { text: "!wort faaak", fragments: [{ type: "text", text: "!wort faaak" }] },
      badges: [{ set_id: "subscriber" }],
    })).toBe(true);
    expect(statisticsWordsExcluded({
      chatter_user_login: "NIGHTBOT",
      message: { text: "hello", fragments: [{ type: "text", text: "hello world" }] },
    })).toBe(true);
    expect(statisticsWordsExcluded({
      chatter_user_login: "fictional_viewer",
      message: { text: "hello", fragments: [{ type: "text", text: "hello world" }] },
    })).toBe(false);
  });
});
