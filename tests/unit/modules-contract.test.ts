import { describe, expect, it } from "vitest";

import type { ModuleResult } from "../../src/modules/contract";
import { clipsModule } from "../../src/modules/clips";
import { MODULES } from "../../src/modules/registry";

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

  it("registers the clips module as default-enabled with a stream-live action", () => {
    expect(MODULES).toContain(clipsModule);
    expect(clipsModule.defaultEnabled).toBe(true);
    expect(clipsModule.immediateActions?.requires).toEqual(["streamLive"]);
  });
});
