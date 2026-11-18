import { describe, expect, it } from "vitest";

import { songVoteLabels } from "../../src/modules/song_requests/domain/vote-labels";

describe("song vote labels", () => {
  it("truncates labels to the chat vote limit and keeps at most nine options", () => {
    const labels = songVoteLabels(Array.from({ length: 12 }, (_value, index) => ({
      name: `A very long fictional track name number ${String(index + 1)}`,
      artists: [],
    })));

    expect(labels).toHaveLength(9);
    expect(labels.every((label) => Array.from(label).length <= 32)).toBe(true);
    expect(new Set(labels).size).toBe(9);
  });

  it("uses safe fallback labels for names without vote text", () => {
    expect(songVoteLabels([{ name: "!!!", artists: [] }, { name: "   ", artists: [] }])).toEqual(["Track 1", "Track 2"]);
  });

  it("keeps a short title suffix and removes it only when the label needs shortening", () => {
    expect(songVoteLabels([
      { name: "Glass Harbor - Live", artists: [{ name: "Mira Vale" }] },
      { name: "Dust in the Wind - From 'Fictional Film' Soundtrack", artists: [{ name: "Rowan March" }] },
    ])).toEqual([
      "Mira Vale – Glass Harbor - Live",
      "Rowan March – Dust in the Wind",
    ]);
  });

  it("keeps the first artist and removes verbose title suffixes before shortening", () => {
    const labels = songVoteLabels([
      { name: "Dust in the Wind - From 'Fictional Film' Soundtrack", artists: [{ name: "Rowan March" }] },
      { name: "Dust in the Wind", artists: [{ name: "Mira Vale" }] },
    ]);

    expect(labels).toEqual(["Rowan March – Dust in the Wind", "Mira Vale – Dust in the Wind"]);
    expect(labels.every((label) => Array.from(label).length <= 32)).toBe(true);
  });
});
