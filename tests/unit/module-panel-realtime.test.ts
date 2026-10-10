import { describe, expect, it } from "vitest";

import { realtimeRecipients } from "../../src/realtime-contract";
import { modulePanelHintMessage } from "../../src/worker/module-panel-realtime";

describe("module panel realtime hints", () => {
  it("publishes bounded panel-only hints without module data or secrets", () => {
    const cases = [
      { moduleId: "belabox", part: "live" },
      { moduleId: "chat_voting", part: "panel" },
      { moduleId: "votekick", part: "availability" },
    ] as const;

    for (const { moduleId, part } of cases) {
      const message = modulePanelHintMessage("channel-a", moduleId, part);

      expect(message).not.toBeNull();
      expect(message?.payload).toEqual({ part });
      expect(message === null ? [] : realtimeRecipients(message.type)).toEqual(["panel"]);
      expect(JSON.stringify(message)).not.toMatch(/statsUrl|publisherKey|payloadData/iu);
    }
  });

  it("rejects a module and part pair outside the allowlist", () => {
    expect(modulePanelHintMessage("channel-a", "belabox", "panel")).toBeNull();
    expect(modulePanelHintMessage("channel-a", "unknown", "panel")).toBeNull();
  });
});
