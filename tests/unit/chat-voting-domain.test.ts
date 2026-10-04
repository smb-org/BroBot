import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import { formatVoteResult, isValidVoteLabelSetting, labelsForVote, parseVoteCommand, voteCloseDeadline } from "../../src/modules/chat_voting/domain";

describe("chat voting command and result domain", () => {
  it("parses only the supported start and end commands", () => {
    expect(parseVoteCommand("!vote yesno")).toEqual({ kind: "start", preset: "yes_no", optionCount: 2 });
    expect(parseVoteCommand("!vote SCALE")).toEqual({ kind: "start", preset: "scale_5", optionCount: 5 });
    expect(parseVoteCommand("!vote 9")).toEqual({ kind: "start", preset: "options_n", optionCount: 9 });
    expect(parseVoteCommand("!vote end")).toEqual({ kind: "end" });
    expect(parseVoteCommand("!vote anything")).toEqual({ kind: "help" });
    expect(parseVoteCommand("!vote yesno extra")).toBeNull();
    expect(parseVoteCommand("hello !vote yesno")).toBeNull();
  });

  it("uses channel-language defaults and complete configured labels", () => {
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "yes_no", 2, "de")).toEqual(["Ja", "Nein"]);
    expect(labelsForVote({ ...DEFAULT_CHAT_VOTING_SETTINGS, scaleLabels: "Low|Medium|High|Great|Perfect" }, "scale_5", 5, "en"))
      .toEqual(["Low", "Medium", "High", "Great", "Perfect"]);
    expect(labelsForVote({ ...DEFAULT_CHAT_VOTING_SETTINGS, optionLabels: "Red|Blue|Green" }, "options_n", 2, "en"))
      .toEqual(["Red", "Blue"]);
  });

  it("accepts empty labels as defaults and rejects malformed custom labels", () => {
    expect(isValidVoteLabelSetting("", "yesNoLabels")).toBe(true);
    expect(isValidVoteLabelSetting("  ", "scaleLabels")).toBe(true);
    expect(isValidVoteLabelSetting("", "optionLabels")).toBe(true);
    expect(isValidVoteLabelSetting("Ja|Nein", "yesNoLabels")).toBe(true);
    expect(isValidVoteLabelSetting("Ja|", "yesNoLabels")).toBe(false);
    expect(isValidVoteLabelSetting("Ja|Nein|Vielleicht", "yesNoLabels")).toBe(false);
    expect(isValidVoteLabelSetting("1|2|3|4|5", "scaleLabels")).toBe(true);
    expect(isValidVoteLabelSetting("1|2|3", "scaleLabels")).toBe(false);
    expect(isValidVoteLabelSetting("A|B|C", "optionLabels")).toBe(true);
    expect(isValidVoteLabelSetting("A", "optionLabels")).toBe(false);
    expect(isValidVoteLabelSetting(`${"x".repeat(33)}|No`, "yesNoLabels")).toBe(false);
  });

  it("formats aggregate results and honors the timer-off hard limit", () => {
    expect(formatVoteResult(["Yes", "No"], [2, 1])).toBe("Yes: 2 (67%) · No: 1 (33%)");
    expect(voteCloseDeadline(10_000, 0)).toEqual({ closesAt: 14_410_000, reason: "limit" });
    expect(voteCloseDeadline(10_000, 30)).toEqual({ closesAt: 40_000, reason: "timer" });
  });
});
