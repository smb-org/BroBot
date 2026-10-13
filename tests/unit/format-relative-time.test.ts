import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../../src/dashboard/ui/format-relative-time";

const now = new Date("2026-10-13T12:00:00.000Z");

describe("formatRelativeTime", () => {
  it.each([
    {
      language: "de" as const,
      relative: "vor 10 Min.",
      relativeExact: "13.10.2026, 13:50:00 GMT+2",
      yesterday: "Mo 09:00",
      yesterdayExact: "12.10.2026, 09:00:00 GMT+2",
      older: "Sa 09:05",
      olderExact: "10.10.2026, 09:05:00 GMT+2",
    },
    {
      language: "en" as const,
      relative: "10 min. ago",
      relativeExact: "10/13/2026, 01:50:00 PM GMT+2",
      yesterday: "Mon 09:00 AM",
      yesterdayExact: "10/12/2026, 09:00:00 AM GMT+2",
      older: "Sat 09:05 AM",
      olderExact: "10/10/2026, 09:05:00 AM GMT+2",
    },
  ])("formats relative, yesterday and exact values in $language", ({ language, relative, relativeExact, yesterday, yesterdayExact, older, olderExact }) => {
    expect(formatRelativeTime("2026-10-13T11:50:00.000Z", now, language, "Europe/Berlin")).toEqual({
      label: relative,
      exact: relativeExact,
    });
    expect(formatRelativeTime("2026-10-12T07:00:00.000Z", now, language, "Europe/Berlin")).toEqual({
      label: yesterday,
      exact: yesterdayExact,
    });
    expect(formatRelativeTime("2026-10-10T07:05:00.000Z", now, language, "Europe/Berlin")).toEqual({
      label: older,
      exact: olderExact,
    });
  });

  it("uses channel-local calendar days when the UTC date differs", () => {
    expect(formatRelativeTime(
      "2026-10-12T21:30:00.000Z",
      "2026-10-12T23:15:00.000Z",
      "de",
      "Europe/Berlin",
    )).toEqual({ label: "vor 2 Std.", exact: "12.10.2026, 23:30:00 GMT+2" });
  });

  it("distinguishes repeated wall-clock times across a daylight-saving transition", () => {
    const firstOccurrence = formatRelativeTime("2026-10-25T00:30:00.000Z", now, "de", "Europe/Berlin");
    const secondOccurrence = formatRelativeTime("2026-10-25T01:30:00.000Z", now, "de", "Europe/Berlin");

    expect(firstOccurrence.exact).toBe("25.10.2026, 02:30:00 GMT+2");
    expect(secondOccurrence.exact).toBe("25.10.2026, 02:30:00 GMT+1");
    expect(firstOccurrence.exact).not.toBe(secondOccurrence.exact);
  });
});
