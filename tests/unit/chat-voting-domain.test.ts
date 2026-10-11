import { describe, expect, it } from "vitest";

import { CHAT_VOTING_TITLE_MAX_LENGTH, DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import { chatVotingChatText } from "../../src/modules/chat_voting/contracts/chat-defaults";
import {
  CHAT_VOTING_LABEL_MAX_LENGTH,
  formatFreeTextVoteResult,
  formatVoteResult,
  configuredLabels,
  isBlockedFreeTextVote,
  isValidVoteLabel,
  isValidTemplateShortcut,
  isValidVoteTitle,
  labelsForVote,
  normalizeBlockedVoteTerm,
  normalizeFreeTextVote,
  parseVoteCommand,
  rankVoteTerms,
  validateVoteLabels,
  voteChoiceFromMessage,
  voteCloseDeadline,
  voteLabelLength,
} from "../../src/modules/chat_voting/domain";

describe("chat voting command and result domain", () => {
  const parserCases: Array<[string, unknown]> = [
    ["!vote", { kind: "help" }],
    ["!vote help", { kind: "help" }],
    ["!vote end", { kind: "end" }],
    ["!vote again", { kind: "again" }],
    ["!vote yesno", { kind: "legacyAlias", alias: "yesno", title: null }],
    ["!vote scale", { kind: "legacyAlias", alias: "scale", title: null }],
    ["!vote 01", { kind: "legacyAlias", alias: "zeroOne", title: null }],
    ["!vote 12", { kind: "legacyAlias", alias: "oneTwo", title: null }],
    ["!vote 2", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 2, title: null }],
    ["!vote 3", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 3, title: null }],
    ["!vote 4", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 4, title: null }],
    ["!vote 5", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 5, title: null }],
    ["!vote 6", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 6, title: null }],
    ["!vote 7", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 7, title: null }],
    ["!vote 8", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 8, title: null }],
    ["!vote 9", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 9, title: null }],
    ["!vote text", { kind: "start", voteKind: "free_text", preset: "free_text", optionCount: 0, title: null, textMode: "first_word" }],
    ["!vote text word", { kind: "start", voteKind: "free_text", preset: "free_text", optionCount: 0, title: null, textMode: "first_word" }],
    ["!vote text message", { kind: "start", voteKind: "free_text", preset: "free_text", optionCount: 0, title: null, textMode: "whole_message" }],
    ["!vote text message Which message wins?", { kind: "start", voteKind: "free_text", preset: "free_text", optionCount: 0, title: "Which message wins?", textMode: "whole_message" }],
    ["!vote yesno  Pizza today?  ", { kind: "legacyAlias", alias: "yesno", title: "Pizza today?" }],
    ["!vote 3 Who wins?", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 3, title: "Who wins?" }],
    ["!vote Pizza or Burger?", { kind: "start", voteKind: "yes_no", preset: "yes_no", optionCount: 2, title: "Pizza or Burger?" }],
    ["!vote Dinner? | Pizza | Burger", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 2, labels: ["Pizza", "Burger"], title: "Dinner?" }],
    ["!vote Dinner? | Pizza | Burger | 90s", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 2, labels: ["Pizza", "Burger"], title: "Dinner?", durationSeconds: 90 }],
    ["!vote Dinner? | Pizza | Burger | 2m", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 2, labels: ["Pizza", "Burger"], title: "Dinner?", durationSeconds: 120 }],
    ["!vote Dinner? | Pizza | Burger | 1h", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 2, labels: ["Pizza", "Burger"], title: "Dinner?", durationSeconds: 3600 }],
    ["!vote 2 Pizzas? | A | B", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 2, labels: ["A", "B"], title: "2 Pizzas?" }],
    ["!vote UnknownToken", { kind: "template", shortcut: "unknowntoken" }],
    ["!vote 10", { kind: "template", shortcut: "10" }],
    ["!vote Question | A | B", { kind: "invalid", problem: "question" }],
    ["!vote Question? | A", { kind: "invalid", problem: "answerCount" }],
    ["!vote Question? | Same | same!", { kind: "invalid", problem: "labels" }],
    ["!vote Question? | A | B | 0s", { kind: "invalid", problem: "duration" }],
    ["!vote Question? | A | B | 5minutes", { kind: "start", voteKind: "options", preset: "options_n", optionCount: 3, labels: ["A", "B", "5minutes"], title: "Question?" }],
  ];

  it.each(parserCases)("parses %s", (input, expected) => {
    expect(parseVoteCommand(input)).toEqual(expected);
  });

  it("rejects overlong command questions and ignores commands outside the message start", () => {
    expect(parseVoteCommand(`!vote yesno ${"😀".repeat(CHAT_VOTING_TITLE_MAX_LENGTH + 1)}`))
      .toEqual({ kind: "invalid", problem: "questionTooLong" });
    expect(parseVoteCommand(`!vote ${"x".repeat(CHAT_VOTING_TITLE_MAX_LENGTH + 1)}? | A | B`))
      .toEqual({ kind: "invalid", problem: "questionTooLong" });
    expect(parseVoteCommand("hello !vote yesno")).toBeNull();
  });

  it("counts optional questions in trimmed Unicode code points", () => {
    expect(isValidVoteTitle("  " )).toBe(true);
    expect(isValidVoteTitle("😀".repeat(CHAT_VOTING_TITLE_MAX_LENGTH))).toBe(true);
    expect(isValidVoteTitle("😀".repeat(CHAT_VOTING_TITLE_MAX_LENGTH + 1))).toBe(false);
  });

  it("localizes title-aware start and result announcements while preserving untitled defaults", () => {
    expect(chatVotingChatText("en", "started", 2, "yes_no", null)).toBe("Voting started. Type a number from 1 to 2 to vote.");
    expect(chatVotingChatText("en", "started", 2, "yes_no", null, "Pizza today?")).toBe("Voting “Pizza today?” started. Type a number from 1 to 2 to vote.");
    expect(chatVotingChatText("de", "started", 2, "free_text", "whole_message", "Was essen wir?")).toBe("Abstimmung „Was essen wir?“ gestartet. Stimme mit einer Nachricht ab.");
    expect(chatVotingChatText("en", "result", undefined, undefined, undefined, null, "Yes: 8 · No: 4")).toBe("Yes: 8 · No: 4");
    expect(chatVotingChatText("en", "result", undefined, undefined, undefined, "Pizza?", "Yes: 8 · No: 4"))
      .toBe("Results for “Pizza?”: Yes: 8 · No: 4");
  });

  it("uses channel-language defaults after customizable defaults move to templates", () => {
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "yes_no", 2, "de")).toEqual(["Ja", "Nein"]);
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "digit_01", 2, "de")).toEqual(["Nein", "Ja"]);
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "digit_01", 2, "en")).toEqual(["No", "Yes"]);
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "digit_12", 2, "de")).toEqual(["1", "2"]);
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "options_n", 3, "en")).toEqual(["1", "2", "3"]);
  });

  it("validates per-vote labels against the selected option count", () => {
    expect(configuredLabels([" Pizza ", "Burger"], 2)).toEqual(["Pizza", "Burger"]);
    expect(configuredLabels(["Yes"], 2)).toBeNull();
    expect(configuredLabels(["Yes", " "], 2)).toBeNull();
    expect(configuredLabels(["x".repeat(33), "No"], 2)).toBeNull();
    expect(configuredLabels(["one", "two", "three"], 2)).toBeNull();
    expect(validateVoteLabels(["Pizza", "burger!"])).toBe(true);
    expect(validateVoteLabels(["Pizza", "pizza"])).toBe(false);
    expect(validateVoteLabels(["!!!", "Burger"])).toBe(false);
    expect(validateVoteLabels(["1", "2"])).toBe(true);
  });

  it("counts vote-label limits in Unicode code points", () => {
    const seventeenEmoji = "😀".repeat(17);
    expect(CHAT_VOTING_LABEL_MAX_LENGTH).toBe(32);
    expect(voteLabelLength(seventeenEmoji)).toBe(17);
    expect(isValidVoteLabel(seventeenEmoji)).toBe(true);
    expect(configuredLabels([seventeenEmoji, "No"], 2)).toEqual([seventeenEmoji, "No"]);
    expect(configuredLabels(["😀".repeat(33), "No"], 2)).toBeNull();
  });

  it("validates chat shortcuts against the client-side grammar and reserved words", () => {
    expect(isValidTemplateShortcut("essen")).toBe(true);
    expect(isValidTemplateShortcut("pizza_today-2")).toBe(true);
    expect(isValidTemplateShortcut("yesno")).toBe(false);
    expect(isValidTemplateShortcut("2essen")).toBe(false);
    expect(isValidTemplateShortcut("a".repeat(25))).toBe(false);
    expect(isValidTemplateShortcut(null)).toBe(true);
  });

  it.each(["!vote 01", "!vote 12"])("ignores label words in a yes/no vote started by %s", (text) => {
    const command = parseVoteCommand(text);
    if (command?.kind !== "legacyAlias") throw new Error("Expected a legacy alias command.");
    expect(command.title).toBeNull();
    expect(voteChoiceFromMessage("Yes", "yes_no", 2, ["No", "Yes"])).toBeNull();
    expect(voteChoiceFromMessage("2", "yes_no", 2, ["No", "Yes"])).toEqual({ choice: 2, source: "number" });
  });

  it("falls back to plain numbers when configured option labels collide with key numbers", () => {
    expect(labelsForVote(DEFAULT_CHAT_VOTING_SETTINGS, "options_n", 3, "en")).toEqual(["1", "2", "3"]);
  });

  it("trims numeric choices and matches option words only by exact normalized labels", () => {
    expect(voteChoiceFromMessage(" 1 ", "yes_no", 2)).toEqual({ choice: 1, source: "number" });
    expect(voteChoiceFromMessage(" 2 ", "options", 2, ["Pizza", "Burger"])).toEqual({ choice: 2, source: "number" });
    expect(voteChoiceFromMessage("0", "options", 2, ["Pizza", "Burger"])).toBeNull();
    expect(voteChoiceFromMessage("  ＰＩＺＺＡ! ", "options", 2, ["Pizza", "Burger"])).toEqual({ choice: 1, source: "word" });
    expect(voteChoiceFromMessage("Pizza extra", "options", 2, ["Pizza", "Burger"])).toBeNull();
    expect(voteChoiceFromMessage("2", "options", 2, ["One", "2"])).toEqual({ choice: 2, source: "number" });
    expect(voteChoiceFromMessage("2!", "options", 2, ["One", "2"])).toBeNull();
    expect(voteChoiceFromMessage("Yes", "yes_no", 2, ["Yes", "No"])).toBeNull();
    expect(voteChoiceFromMessage("!!!", "options", 2, ["Pizza", "Burger"])).toBeNull();
  });

  it("normalizes free-text words and whole messages with Unicode punctuation rules", () => {
    expect(normalizeFreeTextVote("ＫＡＰＰＡ, PogChamp!", "first_word")).toBe("kappa");
    expect(normalizeFreeTextVote("ＫＡＰＰＡ, PogChamp!", "whole_message")).toBe("kappa pogchamp");
    expect(normalizeFreeTextVote("😀Kappa", "first_word")).toBe("😀kappa");
    expect(normalizeFreeTextVote("!!!   ???", "whole_message")).toBeNull();
    expect(normalizeFreeTextVote("abcdefghijklmnopqrstuvwxyz", "whole_message")).toBe("abcdefghijklmnopqrstuvwxy");
    const cut = normalizeFreeTextVote("this is a regular normal sentence", "whole_message");
    expect(cut).toBe("this is a regular normal");
    expect(normalizeBlockedVoteTerm(cut ?? "")).toBe(cut);
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

describe("chat voting normalization performance", () => {
  it("normalizes pathological long input in linear time", () => {
    const noise = " .!?*😀\t".repeat(7_200);
    const inputs = [noise, `${"*".repeat(50_000)}x`, `x${"*".repeat(50_000)} y`, " ".repeat(50_000) + "!", `x${"*".repeat(50_000)}y`, `${"*".repeat(50_000)}y${"*".repeat(50_000)}x`];
    const started = performance.now();
    for (const input of inputs) {
      normalizeFreeTextVote(input, "whole_message");
      normalizeBlockedVoteTerm(input);
      parseVoteCommand(input);
    }
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("parses vote commands with long whitespace runs in linear time", () => {
    const inputs = ["!vote" + " ".repeat(50_000) + "x", "!vote text " + "\t ".repeat(50_000) + "y"];
    const started = performance.now();
    for (const input of inputs) parseVoteCommand(input);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
