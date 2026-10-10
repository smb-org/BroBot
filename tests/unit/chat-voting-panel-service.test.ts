import { describe, expect, it } from "vitest";

import type { ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";
import { templateStartProblem } from "../../src/modules/chat_voting/domain";
import { mergeChatVoteTemplateLists } from "../../src/modules/chat_voting/panel/service";

const template = (id: string, title: string, shortcut: string | null, labels: readonly string[], durationSeconds: number): ChatVoteTemplate => ({
  id,
  channelId: "fictional-channel",
  shortcut,
  title,
  labels,
  freeTextMode: null,
  durationSeconds,
  revision: 1,
  legacyAlias: null,
  lastUsedAt: null,
  createdAt: "2026-10-04T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:00.000Z",
});

describe("chat voting panel template refresh", () => {
  it("merges refreshed configuration and membership while preserving session order", () => {
    const first = { ...template("first", "First", "first", ["Yes", "No"], 60), lastUsedAt: "2026-10-04T10:01:00.000Z" };
    const removed = template("removed", "Removed", "removed", ["Yes", "No"], 120);
    const second = template("second", "Second", "second", ["Yes", "No"], 300);
    const refreshedSecond = { ...second, title: "Updated second", shortcut: "second-v2", labels: ["Only one"], durationSeconds: 90, revision: 2 };
    const refreshedFirst = { ...first, title: "Updated first", shortcut: "first-v2", labels: ["Up", "Down", "Stay"], durationSeconds: 180, revision: 2 };
    const added = template("added", "Added", "added", ["A", "B"], 0);

    const merged = mergeChatVoteTemplateLists(
      { templates: [first, removed, second], count: 3, maximum: 100 },
      { templates: [added, refreshedSecond, refreshedFirst], count: 3, maximum: 100 },
    );

    expect(merged.templates.map(({ id }) => id)).toEqual(["first", "second", "added"]);
    expect(merged.templates).toEqual([{ ...refreshedFirst, lastUsedAt: first.lastUsedAt }, refreshedSecond, added]);
    const secondResult = merged.templates.find(({ id }) => id === "second");
    if (secondResult === undefined) throw new Error("The refreshed second template was omitted.");
    expect(templateStartProblem(secondResult)).toBe("answers");
  });
});
