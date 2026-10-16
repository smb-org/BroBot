import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync("src/dashboard/styles.css", "utf8");

describe("removed chat vote start controls", () => {
  it("does not retain start-row reservations or their orphaned selectors", () => {
    expect(styles).not.toContain("chat-voting-editor__start-row");
    expect(styles).not.toContain("chat-voting-editor__start-reason");
    expect(styles).not.toContain("chat-voting-editor__start-button");
    expect(styles).not.toContain("chat-voting-recent-inspector__footer");
    expect(styles).toContain(".chat-voting-template-inspector .chat-voting-editor__footer { box-sizing: border-box; display: flex; height: 64px; min-height: 64px;");
  });
});
