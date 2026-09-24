import { describe, expect, it } from "vitest";

import { minimumTierAfterVariableOperation } from "../../src/modules/text_commands/panel/editor-state";

describe("text command editor defaults", () => {
  it("defaults set_argument to moderators until the user chooses a tier in the draft", () => {
    expect(minimumTierAfterVariableOperation("everyone", "set_argument", false)).toBe("moderator");
  });

  it("preserves an explicit everyone choice and existing stronger tiers", () => {
    expect(minimumTierAfterVariableOperation("everyone", "set_argument", true)).toBe("everyone");
    expect(minimumTierAfterVariableOperation("vip", "set_argument", false)).toBe("vip");
  });

  it("does not change the tier for other variable operations", () => {
    expect(minimumTierAfterVariableOperation("everyone", "add", false)).toBe("everyone");
  });
});
