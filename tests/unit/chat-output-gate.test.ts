import { describe, expect, it } from "vitest";

import { chatOutputSuppressionReason } from "../../src/worker/chat-output-gate";

describe("host chat output gate", () => {
  it("suppresses disabled or paused modules and muted channels", () => {
    expect(chatOutputSuppressionReason({ moduleEnabled: false, mandatory: false, paused: false, muted: false }))
      .toBe("module_disabled");
    expect(chatOutputSuppressionReason({ moduleEnabled: true, mandatory: false, paused: true, muted: false }))
      .toBe("channel_paused");
    expect(chatOutputSuppressionReason({ moduleEnabled: true, mandatory: false, paused: false, muted: true }))
      .toBe("channel_muted");
    expect(chatOutputSuppressionReason({ moduleEnabled: true, mandatory: true, paused: true, muted: false })).toBeNull();
  });
});
