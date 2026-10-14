import { describe, expect, it } from "vitest";

import { inputFromDraft } from "../../src/modules/faq/panel/draft";
import { templateTextLength } from "../../src/contracts/template-text-length";

describe("FAQ panel template length", () => {
  it("allows a namespaced answer whose semantic length is exactly the limit", () => {
    const answerText = `${"x".repeat(491)}{text.welcome}`;

    expect(answerText).toHaveLength(505);
    expect(templateTextLength(answerText)).toBe(500);
    expect(inputFromDraft({
      name: "Greeting",
      enabled: true,
      matcherType: "keywords",
      patterns: "hello",
      answerText,
      minimumTier: "everyone",
      cooldownSeconds: 30,
      userCooldownSeconds: 0,
      games: [],
      restrictGames: false,
      chatTarget: "source_only",
    })).toMatchObject({ answerText });
  });
});
