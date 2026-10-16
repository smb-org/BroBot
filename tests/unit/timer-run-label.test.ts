import { describe, expect, it } from "vitest";

import { formatTimerRunLabel } from "../../src/modules/timers/panel/format-timer-run-label";

describe("formatTimerRunLabel", () => {
  const now = "2026-10-16T10:00:00.000Z";

  it("keeps the German weekday punctuation used in timer run labels", () => {
    expect(formatTimerRunLabel("2026-10-13T10:30:00.000Z", now, "de", "Europe/Berlin")).toBe("Di. 12:30");
  });

  it("keeps the localized English weekday and clock format", () => {
    expect(formatTimerRunLabel("2026-10-13T10:30:00.000Z", now, "en", "Europe/Berlin")).toBe("Tue 12:30 PM");
  });

  it("does not add weekday punctuation to same-day relative time", () => {
    expect(formatTimerRunLabel("2026-10-16T09:30:00.000Z", now, "de", "Europe/Berlin")).toBe("vor 30 Min.");
  });
});
