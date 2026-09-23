import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";

describe("Browser Vitest scaffold", () => {
  it("starts with the registered text-commands module", () => {
    expect(MODULES.map((module) => module.id)).toEqual(["text_commands", "channel_events", "ads", "raid", "clips"]);
  });
});
