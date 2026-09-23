import { describe, expect, it } from "vitest";

import { evaluateImmediateActionAvailability } from "../../src/dashboard/immediate-action-availability";

describe("immediate action availability", () => {
  it("allows a stream-live action while the stream is online", () => {
    expect(evaluateImmediateActionAvailability(["streamLive"], "online")).toEqual({ enabled: true, reason: null });
  });

  it("returns a catalogue reason while the stream is offline", () => {
    expect(evaluateImmediateActionAvailability(["streamLive"], "offline")).toEqual({ enabled: false, reason: "stream_offline" });
  });

  it.each([null, undefined])("returns an unknown-state catalogue reason for %s", (streamState) => {
    expect(evaluateImmediateActionAvailability(["streamLive"], streamState)).toEqual({ enabled: false, reason: "stream_state_unknown" });
  });

  it("allows an action with no declared availability requirements", () => {
    expect(evaluateImmediateActionAvailability([], undefined)).toEqual({ enabled: true, reason: null });
  });
});
