import { describe, expect, it } from "vitest";

import type { DryRunEntryKind, DryRunMatch, DryRunSenderStatus } from "../../src/contracts/dry-run";

describe("dry-run shared contract", () => {
  it("keeps the text-command entry, match, and synthetic sender status shapes available", () => {
    const entryKind: DryRunEntryKind = "text_command";
    const match: DryRunMatch = { kind: "alias", token: "hi" };
    const senderStatus: DryRunSenderStatus = "subscriber";

    expect({ entryKind, match, senderStatus }).toEqual({
      entryKind: "text_command",
      match: { kind: "alias", token: "hi" },
      senderStatus: "subscriber",
    });
  });
});
