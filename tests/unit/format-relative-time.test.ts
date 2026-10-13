import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../../src/dashboard/ui/format-relative-time";

const now = new Date("2026-10-13T12:00:00.000Z");

describe("formatRelativeTime", () => {
  it.each([
    {
      language: "de" as const,
      relative: "vor 10 Min.",
      relativeExact: "13.10.2026, 13:50",
      yesterday: "gestern · 09:00",
      yesterdayExact: "12.10.2026, 09:00",
      older: "vor 3 Tagen · 09:05",
      olderExact: "10.10.2026, 09:05",
    },
    {
      language: "en" as const,
      relative: "10 min. ago",
      relativeExact: "Oct 13, 2026, 1:50 PM",
      yesterday: "yesterday · 09:00 AM",
      yesterdayExact: "Oct 12, 2026, 9:00 AM",
      older: "3 days ago · 09:05 AM",
      olderExact: "Oct 10, 2026, 9:05 AM",
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
    )).toEqual({ label: "vor 2 Std.", exact: "12.10.2026, 23:30" });
  });
});
