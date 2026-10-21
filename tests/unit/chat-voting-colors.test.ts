import { describe, expect, it } from "vitest";

import {
  chatVoteDefaultColors,
  normalizeChatVoteColor,
  voteColorContrastRatio,
} from "../../src/modules/chat_voting/contracts/vote-colors";
import { chatVoteAnswerColorsSchema } from "../../src/modules/chat_voting/contracts/chat-vote-colors-schema";
import { chatVoteTemplateDraftSchema } from "../../src/modules/chat_voting/contracts";

describe("chat vote answer colors", () => {
  it.each([
    [2, ["#5b8cff", "#ff9f43"]],
    [6, ["#5b8cff", "#ff9f43", "#2ed3a3", "#ff6fae", "#ffd45c", "#a47bff"]],
    [9, ["#5b8cff", "#ff9f43", "#2ed3a3", "#ff6fae", "#ffd45c", "#a47bff", "#68aeff", "#ff665c", "#c3ccdd"]],
  ])("provides distinct defaults for %i answers", (count, expected) => {
    const colors = chatVoteDefaultColors(count);
    expect(colors).toEqual(expected);
    expect(new Set(colors).size).toBe(count);
  });

  it("normalizes valid hex to lowercase", () => {
    expect(normalizeChatVoteColor("#5B8CFF")).toBe("#5b8cff");
    expect(normalizeChatVoteColor("#abc")).toBeNull();
  });

  it("rejects duplicate colors and colors below either contrast threshold", () => {
    expect(chatVoteAnswerColorsSchema.safeParse(["#5B8CFF", "#FF9F43"]).data).toEqual(["#5b8cff", "#ff9f43"]);
    expect(chatVoteAnswerColorsSchema.safeParse(["#5B8CFF", "#5b8cff"]).success).toBe(false);
    expect(chatVoteAnswerColorsSchema.safeParse(["#000000", "#ffffff"]).success).toBe(false);
    expect(voteColorContrastRatio("#5b8cff", "cockpit")).toBeGreaterThanOrEqual(3);
    expect(voteColorContrastRatio("#5b8cff", "overlayTrack")).toBeGreaterThanOrEqual(3);
  });

  it("checks overlay contrast against the translucent track composited over black", () => {
    expect(voteColorContrastRatio("#202020", "overlayTrack")).toBeCloseTo(1, 5);
  });

  it("requires either a chat shortcut or cockpit availability", () => {
    const base = {
      shortcut: null,
      title: "Dinner",
      resultText: "{vote.result}",
      labels: ["Pizza", "Burger"],
      answerColors: ["#5b8cff", "#ff9f43"],
      freeTextMode: null,
      durationSeconds: 120,
      offerInCockpit: false,
    };
    expect(chatVoteTemplateDraftSchema.safeParse(base).success).toBe(false);
    expect(chatVoteTemplateDraftSchema.safeParse({ ...base, shortcut: "dinner" }).success).toBe(true);
    expect(chatVoteTemplateDraftSchema.safeParse({ ...base, offerInCockpit: true }).success).toBe(true);
  });

  it("requires one valid color per fixed answer", () => {
    expect(chatVoteTemplateDraftSchema.safeParse({
      shortcut: "dinner",
      title: "Dinner",
      labels: ["Pizza", "Burger"],
      answerColors: ["#5b8cff"],
      freeTextMode: null,
      durationSeconds: 120,
      offerInCockpit: true,
    }).success).toBe(false);
  });
});
