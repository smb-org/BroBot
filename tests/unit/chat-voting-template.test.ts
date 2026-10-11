import { describe, expect, it } from "vitest";

import { chatVotingModule } from "../../src/modules/chat_voting";
import { DEFAULT_CHAT_VOTING_START_TEXT, DEFAULT_CHAT_VOTING_START_TEXT_EN } from "../../src/modules/chat_voting/contracts";
import type { ChatVote } from "../../src/modules/chat_voting/contracts";
import { chatVotingTemplateValues, startAnnouncementTemplate } from "../../src/modules/chat_voting/service";
import { renderTemplate } from "../../src/template";

const voteFor = (language: "de" | "en", requestedDurationSeconds: number | null, title: string | null = "What should we eat today?"): ChatVote => ({
  id: "vote-a",
  channelId: "channel-a",
  kind: "options",
  optionCount: 3,
  labels: language === "de" ? ["Pizza", "Burger", "Döner"] : ["Pizza", "Burger", "Kebab"],
  title,
  status: "open",
  openedAt: "2030-01-01T00:00:00.000Z",
  closesAt: "2030-01-01T00:01:30.000Z",
  requestedDurationSeconds,
  closedAt: null,
  closeReason: "timer",
  counts: null,
  voterCount: null,
});

describe("chat voting duration templates", () => {
  it.each([
    ["de", 90, "90 Sekunden"],
    ["de", null, ""],
    ["en", 90, "90 seconds"],
    ["en", null, ""],
  ] as const)("renders vote.duration for %s with duration %s", (language, seconds, expected) => {
    const vote = voteFor(language, seconds);
    const values = chatVotingTemplateValues(vote, language, "Pizza: 2 (100%)");
    const startFields = chatVotingModule.templateFields?.startText ?? [];
    const resultFields = chatVotingModule.templateFields?.resultText ?? [];

    expect(renderTemplate("{vote.duration}", values, {}, startFields)).toBe(expected);
    expect(renderTemplate("{vote.duration}", values, {}, resultFields)).toBe(expected);
    expect(startFields.map(({ name }) => name)).toContain("vote.duration");
    expect(resultFields.map(({ name }) => name)).toContain("vote.duration");
  });

  it.each([
    ["de", true, true],
    ["de", false, true],
    ["de", true, false],
    ["de", false, false],
    ["en", true, true],
    ["en", false, true],
    ["en", true, false],
    ["en", false, false],
  ] as const)("renders the %s default start text with title=%s and duration=%s", (language, hasTitle, hasDuration) => {
    const title = hasTitle ? language === "de" ? "Was essen wir heute?" : "What should we eat today?" : null;
    const durationSeconds = hasDuration ? 120 : null;
    const vote = voteFor(language, durationSeconds, title);
    const values = chatVotingTemplateValues(vote, language);
    const storedDefault = language === "de" ? DEFAULT_CHAT_VOTING_START_TEXT : DEFAULT_CHAT_VOTING_START_TEXT_EN;
    const template = startAnnouncementTemplate(storedDefault, title, values["vote.duration"] ?? "", language);
    const rendered = renderTemplate(template, values, {}, chatVotingModule.templateFields?.startText ?? []);
    const options = language === "de" ? "1 = Pizza, 2 = Burger, 3 = Döner" : "1 = Pizza, 2 = Burger, 3 = Kebab";
    const intro = language === "de" ? "Abstimmung gestartet: " : "Vote started: ";
    const titlePart = title === null ? "" : `${title} – `;
    const durationPart = hasDuration ? language === "de" ? " – läuft 2 Minuten" : " – runs for 2 minutes" : "";

    expect(rendered).toBe(`${intro}${titlePart}${options}${durationPart}`);
  });

  it("does not rewrite custom start text when optional values are empty", () => {
    const customText = "Start: {vote.title} / {vote.duration}";

    expect(startAnnouncementTemplate(customText, null, "", "de")).toBe(customText);
  });
});
