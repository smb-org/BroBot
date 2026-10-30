import { describe, expect, it } from "vitest";

import { EVENTSUB_NEUTRAL_REASON_CODES, MAINTENANCE_REASON_CODES } from "../../src/contracts/values";
import { maintenanceReasonText } from "../../src/dashboard/locale";
import { eventSubName } from "../../src/dashboard/module-labels";
import { EVENTSUB_SUBSCRIPTION_DEFINITIONS } from "../../src/worker/eventsub-subscriptions";

const languages = ["de", "en"] as const;

// The shared list of codes the worker writes to maintenance rows, plus the neutral EventSub states.
const knownReasonCodes: readonly string[] = [...EVENTSUB_NEUTRAL_REASON_CODES, ...MAINTENANCE_REASON_CODES];

describe("EventSub labels", () => {
  it.each(languages)("labels every subscription definition in %s", (language) => {
    for (const definition of EVENTSUB_SUBSCRIPTION_DEFINITIONS) {
      const label = eventSubName(definition.subscriptionType, definition.variant, language);
      expect(label, `${definition.subscriptionType}/${definition.variant}`).not.toBe(definition.subscriptionType);
      expect(label).not.toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it("keeps German and English labels distinct for the named raid variants and unknown types raw", () => {
    expect(eventSubName("channel.raid", "incoming", "en")).toBe("Incoming raids");
    expect(eventSubName("channel.raid", "incoming", "de")).toBe("Eingehende Raids");
    expect(eventSubName("channel.update", "", "en")).toBe("Channel updates");
    expect(eventSubName("channel.future_event", "", "en")).toBe("channel.future_event");
  });

  it.each(languages)("localizes every known reason code in %s", (language) => {
    for (const code of knownReasonCodes) {
      expect(maintenanceReasonText(code, language), code).not.toBe(code);
    }
  });

  it("falls back to the raw code for unknown reasons and names HTTP statuses", () => {
    expect(maintenanceReasonText("some_future_reason", "en")).toBe("some_future_reason");
    expect(maintenanceReasonText("http_503", "de")).toBe("HTTP 503");
  });
});
