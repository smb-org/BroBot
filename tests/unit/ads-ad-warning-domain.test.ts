import { describe, expect, it } from "vitest";

import { decideAdPrewarning } from "../../src/modules/ads/domain";

const nowAtMs = Date.parse("2026-09-21T11:59:00.000Z");
const plannedAtMs = Date.parse("2026-09-21T12:00:00.000Z");
const settings = {
  prewarning: true,
  leadSeconds: 60,
  prewarningText: "Werbung in {seconds} Sekunden.",
};

const input = (overrides: Partial<Parameters<typeof decideAdPrewarning>[0]> = {}) => ({
  settings,
  scopeAvailable: true,
  nowAtMs,
  plannedAtMs,
  schedule: {
    nextAdAt: "2026-09-21T12:00:00.000Z",
    lastAdAt: null,
  },
  ...overrides,
});

describe("ad prewarning decision", () => {
  it("announces the unchanged schedule with the placeholder", () => {
    expect(decideAdPrewarning(input())).toEqual({
      kind: "announce",
      text: "Werbung in 60 Sekunden.",
      seconds: 60,
      scheduledAt: "2026-09-21T12:00:00.000Z",
    });
  });

  // An alarm never fires too early, but regularly a few milliseconds too
  // late. Without slack, that would be the normal case and the prewarning
  // would fail every time — a test with exact times wouldn't catch this.
  it("announces even when the alarm fires a second late", () => {
    expect(decideAdPrewarning(input({
      nowAtMs: nowAtMs + 1_100,
    }))).toMatchObject({ kind: "announce", seconds: 59, text: "Werbung in 59 Sekunden." });
  });

  it("ignores the German legacy placeholder name for seconds", () => {
    const result = decideAdPrewarning(input({
      settings: { ...settings, prewarningText: "Werbung in {sekunden} Sekunden." },
    }));

    expect(result).toMatchObject({ kind: "announce", text: "Werbung in {sekunden} Sekunden." });
  });

  it("reports the actually remaining time, not the configured lead time", () => {
    expect(decideAdPrewarning(input({
      nowAtMs: Date.parse("2026-09-21T11:59:15.000Z"),
    }))).toMatchObject({ kind: "announce", seconds: 45, text: "Werbung in 45 Sekunden." });
  });

  it("treats a one-second shift as the same schedule", () => {
    expect(decideAdPrewarning(input({
      schedule: { nextAdAt: "2026-09-21T12:00:01.000Z", lastAdAt: null },
    }))).toMatchObject({ kind: "announce" });
  });

  it.each([
    ["no schedule", { schedule: { nextAdAt: null, lastAdAt: null } }, "kein_termin"],
    ["schedule imminent", { nowAtMs: Date.parse("2026-09-21T11:59:57.000Z") }, "zu_spaet"],
    ["ad break already started", { schedule: { nextAdAt: "2026-09-21T12:05:00.000Z", lastAdAt: "2026-09-21T12:00:01.000Z" } }, "pause_begonnen"],
    ["shifted schedule", { schedule: { nextAdAt: "2026-09-21T12:05:00.000Z", lastAdAt: null } }, "termin_verschoben"],
    ["missing scope", { scopeAvailable: false }, "scope_fehlt"],
  ] as const)("justifies %s with its own code", (_name, overrides, reason) => {
    expect(decideAdPrewarning(input(overrides))).toMatchObject({ kind: "skip", reason });
  });
});
