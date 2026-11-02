import { describe, expect, it } from "vitest";

import type { ModuleTempVipResult } from "../../src/modules/contract";
import { formatTempVipResult } from "../../src/modules/temp_vips/panel/result-message";

const cases: Array<{ result: ModuleTempVipResult; de: string; en: string }> = [
  { result: { status: "rejected", reason: "no_slots" }, de: "VIP-Plätze frei", en: "VIP slots" },
  { result: { status: "rejected", reason: "moderator" }, de: "Moderator:in", en: "moderator" },
  { result: { status: "rejected", reason: "community_gate" }, de: "später erneut", en: "try again later" },
  { result: { status: "already_vip" }, de: "Übernimm", en: "Take it over" },
  { result: { status: "maximum_exceeded", allowedDurationMs: 3 * 86_400_000 }, de: "3 Tage", en: "3 days" },
  { result: { status: "rejected", reason: "unknown_status" }, de: "Twitch", en: "Twitch" },
  { result: { status: "not_managed" }, de: "VIP-Liste", en: "VIP list" },
  { result: { status: "permanent_vip" }, de: "dauerhaft eingestuft", en: "classified as permanent" },
  { result: { status: "unclassified_vip" }, de: "noch nicht eingestuft", en: "has not been classified" },
  { result: { status: "busy" }, de: "Kanalwarteschlange", en: "queue" },
  { result: { status: "queued" }, de: "Kanalwarteschlange", en: "queue" },
];

describe("temporary VIP result explanations", () => {
  it.each(cases)("gives a localized corrective hint for $result.status/$result.reason", ({ result, de, en }) => {
    expect(formatTempVipResult(result, "de", "Europe/Berlin")).toContain(de);
    expect(formatTempVipResult(result, "en", "Europe/Berlin")).toContain(en);
  });

  it("includes the new absolute expiry on a successful extension", () => {
    const result: ModuleTempVipResult = {
      status: "extended",
      expiresAt: "2026-11-02T12:00:00.000Z",
      row: { userId: "user_demo", login: "pixelpilz", displayName: "Pixelpilz", expiresAt: "2026-11-02T12:00:00.000Z", grantedAt: "2026-11-01T12:00:00.000Z", grantedByUserId: null, grantedByLogin: null, source: "dashboard", removalFailedAt: null, removalAttempts: 0, removalError: null, endReason: null, classification: "temporary", confirmation: "confirmed", expiryReminderAt: null },
    };

    expect(formatTempVipResult(result, "de", "UTC")).toContain("02.11.2026");
    expect(formatTempVipResult(result, "en", "UTC")).toContain("11/02/2026");
  });
});
