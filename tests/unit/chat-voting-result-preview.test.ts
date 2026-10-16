import { describe, expect, it } from "vitest";

import { chatVoteResultPreview } from "../../src/modules/chat_voting/panel/result-preview";

const values = { "vote.result": "A: 1 (100%)", "vote.title": "Q?" };

describe("chat vote result preview", () => {
  it("matches the runtime intro for the default text", () => {
    expect(chatVoteResultPreview("de", "{vote.result}", "Q?", "A: 1 (100%)", values)).toBe("Ergebnis „Q?“: A: 1 (100%)");
    expect(chatVoteResultPreview("de", "{vote.result}", null, "A: 1 (100%)", values)).toBe("A: 1 (100%)");
  });

  it("sends a custom text without an added prefix", () => {
    expect(chatVoteResultPreview("de", "Done: {vote.result}", "Q?", "A: 1 (100%)", values)).toBe("Done: A: 1 (100%)");
  });

  it("is empty when the text is blank because delivery is suppressed", () => {
    expect(chatVoteResultPreview("en", "  ", "Q?", "A: 1 (100%)", values)).toBe("");
  });
});
