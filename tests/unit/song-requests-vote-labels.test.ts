import { describe, expect, it } from "vitest";

import { songVoteLabels } from "../../src/modules/song_requests/domain/vote-labels";

describe("song vote labels", () => {
  it("truncates labels to the chat vote limit and keeps at most nine options", () => {
    const labels = songVoteLabels(Array.from({ length: 12 }, (_value, index) => ({
      name: `A very long fictional track name number ${String(index + 1)}`,
    })));

    expect(labels).toHaveLength(9);
    expect(labels.every((label) => Array.from(label).length <= 32)).toBe(true);
    expect(new Set(labels).size).toBe(9);
  });

  it("uses safe fallback labels for names without vote text", () => {
    expect(songVoteLabels([{ name: "!!!" }, { name: "   " }])).toEqual(["Track 1", "Track 2"]);
  });
});
