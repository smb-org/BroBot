import { describe, expect, it } from "vitest";

import type { ModuleResult } from "../../src/modules/contract";

describe("Module contract", () => {
  it("preserves the order of semantic actions in a result", () => {
    const result: ModuleResult = {
      actions: [
        { kind: "chat", text: "Hallo", replyToMessageId: "message-1" },
        { kind: "overlay", type: "raid", payload: { viewers: 42 } },
      ],
      diagnostics: [],
    };

    expect(result.actions).toEqual([
      { kind: "chat", text: "Hallo", replyToMessageId: "message-1" },
      { kind: "overlay", type: "raid", payload: { viewers: 42 } },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
});
