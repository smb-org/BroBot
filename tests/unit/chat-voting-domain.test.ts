import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import {
  formatFreeTextVoteResult,
  formatVoteResult,
  isBlockedFreeTextVote,
  isValidVoteLabelSetting,
  labelsForVote,
  normalizeBlockedVoteTerm,
  normalizeFreeTextVote,
  parseVoteCommand,
  rankVoteTerms,
  voteChoiceFromMessage,
  voteCloseDeadline,
} from "../../src/modules/chat_voting/domain";

describe("chat voting command and result domain", () => {
  it("parses only the supported start and end commands", () => {
    expect(parseVoteCommand("!vote yesno")).toEqual({ kind: "start", preset: "yes_no", optionCount: 2 });
    expect(parseVoteCommand("!vote SCALE")).toEqual({ kind: "start", preset: "scale_5", optionCount: 5 });
    expect(parseVoteCommand("!vote 9")).toEqual({ kind: "start", preset: "options_n", optionCount: 9 });
    expect(parseVoteCommand("!vote 01")).toEqual({ kind: "start", preset: "digit_01", optionCount: 2 });
    expect(parseVoteCommand("!vote 12")).toEqual({ kind: "start", preset: "digit_12", optionCount: 2 });
    expect(parseVoteCommand("!vote text")).toEqual({ kind: "start", preset: "free_text", optionCount: 0, textMode: "first_word" });
    expect(parseVoteCommand("!vote text word")).toEqual({ kind: "start", preset: "free_text", optionCount: 0, textMode: "first_word" });
    expect(parseVoteCommand("!vote text message")).toEqual({ kind: "start", preset: "free_text", optionCount: 0, textMode: "whole_message" });
    expect(parseVoteCommand("!vote text both")).toEqual({ kind: "help" });
    expect(parseVoteCommand("!vote text word extra")).toBeNull();
    expect(parseVoteCommand("!vote end")).toEqual({ kind: "end" });
    expect(parseVoteCommand("!vote anything")).toEqual({ kind: "help" });
    expect(parseVoteCommand("!vote yesno extra")).toEqual({ kind: "help" });
    expect(parseVoteCommand("hello !vote yesno")).toBeNull();
  });

  it("uses channel-language defaults and complete configured labels", () => {
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "yes_no", 2, "de")).toEqual(["Ja", "Nein"]);
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "digit_01", 2, "de")).toEqual(["Nein", "Ja"]);
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "digit_01", 2, "en")).toEqual(["No", "Yes"]);
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "digit_12", 2, "de")).toEqual(["1", "2"]);
    expect(labelsForVote({ ...DEFAULT_CHAT_VOTING_SETTINGS, zeroOneLabels: "Nope|Sure", oneTwoLabels: "One|Two" }, "digit_01", 2, "en"))
      .toEqual(["Nope", "Sure"]);
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
    expect(isValidVoteLabelSetting("Nein|Ja", "zeroOneLabels")).toBe(true);
    expect(isValidVoteLabelSetting("1|2", "oneTwoLabels")).toBe(true);
    expect(isValidVoteLabelSetting("No|Yes|Maybe", "zeroOneLabels")).toBe(false);
    expect(isValidVoteLabelSetting("Ja|", "yesNoLabels")).toBe(false);
    expect(isValidVoteLabelSetting("Ja|Nein|Vielleicht", "yesNoLabels")).toBe(false);
    expect(isValidVoteLabelSetting("1|2|3|4|5", "scaleLabels")).toBe(true);
    expect(isValidVoteLabelSetting("1|2|3", "scaleLabels")).toBe(false);
    expect(isValidVoteLabelSetting("A|B|C", "optionLabels")).toBe(true);
    expect(isValidVoteLabelSetting("A", "optionLabels")).toBe(false);
    expect(isValidVoteLabelSetting(`${"x".repeat(33)}|No`, "yesNoLabels")).toBe(false);
  });

  it("accepts exactly the preset digits and never turns 0 into another preset vote", () => {
    expect(voteChoiceFromMessage("0", "digit_01", 2)).toBe(1);
    expect(voteChoiceFromMessage("1", "digit_01", 2)).toBe(2);
    expect(voteChoiceFromMessage("0", "digit_12", 2)).toBeNull();
    expect(voteChoiceFromMessage("2", "digit_12", 2)).toBe(2);
    expect(voteChoiceFromMessage(" 1", "digit_01", 2)).toBeNull();
    expect(voteChoiceFromMessage("0", "yes_no", 2)).toBeNull();
  });

  it("normalizes free-text words and whole messages with Unicode punctuation rules", () => {
    expect(normalizeFreeTextVote("ＫＡＰＰＡ, PogChamp!", "first_word")).toBe("kappa");
    expect(normalizeFreeTextVote("ＫＡＰＰＡ, PogChamp!", "whole_message")).toBe("kappa pogchamp");
    expect(normalizeFreeTextVote("😀Kappa", "first_word")).toBe("😀kappa");
    expect(normalizeFreeTextVote("!!!   ???", "whole_message")).toBeNull();
    expect(normalizeFreeTextVote("abcdefghijklmnopqrstuvwxyz", "whole_message")).toBe("abcdefghijklmnopqrstuvwxy");
    expect(normalizeBlockedVoteTerm("ＰＯＧＣＨＡＭＰ!")).toBe("pogchamp");
  });

  it("matches blocked phrases and edge wildcards before punctuation normalization", () => {
    expect(normalizeBlockedVoteTerm("Bad Phrase")).toBe("bad phrase");
    expect(normalizeBlockedVoteTerm("shoot*")).toBe("shoot*");
    expect(normalizeBlockedVoteTerm("*hound")).toBe("*hound");
    expect(isBlockedFreeTextVote("this is a BAD, phrase here", ["bad phrase"])).toBe(true);
    expect(isBlockedFreeTextVote("hi there", ["hi there"])).toBe(true);
    expect(isBlockedFreeTextVote("there hi", ["hi there"])).toBe(true);
    expect(isBlockedFreeTextVote("there", ["hi there"])).toBe(false);
    expect(isBlockedFreeTextVote("there hissing", ["hi* there"])).toBe(true);
    expect(isBlockedFreeTextVote("there xhiss", ["hi* there"])).toBe(false);
    expect(isBlockedFreeTextVote("shooting", ["shoot*"])).toBe(true);
    expect(isBlockedFreeTextVote("bloodhound", ["*hound"])).toBe(true);
    expect(isBlockedFreeTextVote("middlepiece", ["*middle*"])).toBe(true);
    expect(isBlockedFreeTextVote("badger", ["bad"])).toBe(false);
    expect(isBlockedFreeTextVote("phrase bad", ["bad phrase"])).toBe(true);
  });

  it("ranks free-text terms by count then name and caps the tally at five", () => {
    const terms = [
      { term: "echo", count: 2, approved: true },
      { term: "bravo", count: 3, approved: true },
      { term: "alpha", count: 3, approved: false },
      { term: "foxtrot", count: 1, approved: true },
      { term: "delta", count: 2, approved: true },
      { term: "charlie", count: 2, approved: true },
    ];
    expect(rankVoteTerms(terms).map(({ term }) => term)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
    expect(formatFreeTextVoteResult(terms, 4, "weitere")).toBe(
      "bravo: 3 (23%) · charlie: 2 (15%) · delta: 2 (15%) · echo: 2 (15%) · foxtrot: 1 (8%) · weitere: 4",
    );
  });

  it("formats aggregate results and honors the timer-off hard limit", () => {
    expect(formatVoteResult(["Yes", "No"], [2, 1])).toBe("Yes: 2 (67%) · No: 1 (33%)");
    expect(voteCloseDeadline(10_000, 0)).toEqual({ closesAt: 14_410_000, reason: "limit" });
    expect(voteCloseDeadline(10_000, 30)).toEqual({ closesAt: 40_000, reason: "timer" });
  });
});
