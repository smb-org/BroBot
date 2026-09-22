import { describe, expect, it } from "vitest";

import { platformActionLabel } from "../../src/dashboard/labels";
import { apiErrorText, eventText, maintenanceReasonText } from "../../src/dashboard/locale";
import { eventMetadata, eventTone } from "../../src/dashboard/events/model";
import { moduleDescription, moduleName } from "../../src/dashboard/module-labels";

describe("external catalogue keys", () => {
  it("resolves the realtime handshake errors in both languages", () => {
    expect(apiErrorText("websocket_origin_invalid", "fallback", "de")).toContain("WebSocket");
    expect(apiErrorText("websocket_origin_invalid", "fallback", "en")).toContain("WebSocket");
    expect(apiErrorText("realtime_protocol_unsupported", "fallback", "de")).toContain("Echtzeitprotokoll");
    expect(apiErrorText("realtime_protocol_unsupported", "fallback", "en")).toContain("realtime protocol");
  });

  it.each(["__proto__", "constructor", "toString"])("does not treat %s as a catalogue entry", (key) => {
    expect(apiErrorText(key, "fallback", "en")).toBe("fallback");
    expect(maintenanceReasonText(key, "en")).toBe(key);
    expect(platformActionLabel(key, "en")).toBe(key);
    expect(eventText(key, "en")).toBe(key);
    expect(eventMetadata(key)).toBeNull();
    expect(eventTone(key)).toBeNull();
    expect(moduleName(key, "en")).toBe(key);
    expect(moduleDescription(key, "en")).toBeNull();
  });

  it("does not resolve inherited keys in event detail labels", () => {
    expect(eventText("text_commands.permission_denied", {
      name: "command",
      requiredTier: "viewer",
      currentTier: "constructor",
    }, "en")).toContain("constructor");
  });
});
