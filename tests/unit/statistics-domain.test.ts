import { describe, expect, it } from "vitest";

import {
  countStatisticsEmotes,
  foldStatisticsWord,
  statisticsTextFragments,
  statisticsWordsExcluded,
  statisticsWindowStart,
  tokenizeStatisticsWordDetails,
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
      chatter_user_login: "viewer",
      message: { text: "!hello", fragments: [{ type: "text", text: "!hello world" }] },
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
