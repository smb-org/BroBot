import { describe, expect, it } from "vitest";

import { channelDateTimeToEpoch } from "../../src/modules/temp_vips/panel/time-zone";

describe("temporary VIP channel-local expiry input", () => {
  it("converts a date and time in the channel zone rather than the browser zone", () => {
    expect(channelDateTimeToEpoch("2026-11-02T13:30", "America/Los_Angeles"))
      .toBe(Date.parse("2026-11-02T21:30:00.000Z"));
  });

  it("rejects local times skipped by a daylight saving transition", () => {
    expect(channelDateTimeToEpoch("2026-03-29T02:30", "Europe/Berlin")).toBeNull();
  });
});
