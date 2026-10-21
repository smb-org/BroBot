import { describe, expect, it } from "vitest";
import { normalizeBlitzAnswer, scrambleBlitzWord } from "../../src/modules/blitz_round/domain/round";
import { BLITZ_STARTER_WORDS } from "../../src/modules/blitz_round/seed-words";
import { formatBlitzResolutionLine } from "../../src/modules/blitz_round/locale";

describe("blitz round text rules", () => {
  it("normalizes umlaut answers and removes punctuation [protects=case, whitespace, umlaut, and punctuation variants converge to one match key; fails_when=umlauts remain distinct or punctuation becomes a separator; no_claim=does not test Twitch message parsing]", () => {
    const plain = BLITZ_STARTER_WORDS[0].toLocaleLowerCase("de-DE");
    const umlaut = plain.replace("o", "\u00f6").toLocaleUpperCase("de-DE");
    expect(normalizeBlitzAnswer(plain.toLocaleUpperCase("de-DE"))).toBe(plain);
    expect(normalizeBlitzAnswer(` ${plain} `)).toBe(plain);
    expect(normalizeBlitzAnswer(`${umlaut}!!!`)).toBe(plain.replace("o", "oe"));
    expect(normalizeBlitzAnswer("A\u00df, \u00e4\u00f6\u00fc")).toBe("ass aeoeue");
    expect(normalizeBlitzAnswer(`${plain.slice(0, 3)}-${plain.slice(3)}`)).toBe(plain);
    expect(normalizeBlitzAnswer("Caf\u00e9\t  CLOUD")).toBe("cafe cloud");
  });

  it("always displays a different uppercase scramble [protects=the live word-scramble prompt cannot reveal the solution unchanged; fails_when=the displayed word equals the solution or loses uppercase form; no_claim=does not assess shuffle fairness]", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const shown = scrambleBlitzWord("CLOUD");
      expect(shown).not.toBe("CLOUD");
      expect(shown).toMatch(/^[A-Z]+$/u);
      expect(Array.from(shown).sort((a, b) => a.localeCompare(b))).toEqual(Array.from("CLOUD").sort((a, b) => a.localeCompare(b)));
    }
  });

  it("formats bounded winner and timeout lines in both locales [protects=resolution output includes ordered names or the answer without exceeding chat length; fails_when=the line omits its outcome or exceeds 500 characters; no_claim=does not test delivery retries]", () => {
    const winners = Array.from({ length: 7 }, (_, index) => ({ accountId: `viewer_${String(index)}`, login: `login_${String(index)}` }));
    const localized = formatBlitzResolutionLine({ language: "de", answer: "CLOUD", winners, share: 25 });
    const english = formatBlitzResolutionLine({ language: "en", answer: "CLOUD", winners, share: 25 });

    expect(localized).toContain("CLOUD");
    expect(localized).toContain("login_0, login_1, login_2, login_3, login_4");
    expect(localized).toContain("+2");
    expect(localized).toContain("25");
    expect(english).toBe("Correct: CLOUD · login_0, login_1, login_2, login_3, login_4, +2 more · +25 each");
    expect(localized.length).toBeLessThanOrEqual(500);
    const timeout = formatBlitzResolutionLine({ language: "de", answer: "CLOUD", winners: [], share: 0 });
    expect(timeout).toContain("CLOUD");
    expect(timeout).toMatch(/CLOUD\.$/u);
  });
});
