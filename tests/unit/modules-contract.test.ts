import { describe, expect, it } from "vitest";

import { apiErrorDetail, localMidnightInTimeZone, nextLocalMidnightInTimeZone, wallTimeInstantsInTimeZone, type ModuleResult } from "../../src/modules/contract";
import { clipsModule } from "../../src/modules/clips";
import { MODULES } from "../../src/modules/registry";

describe("Module contract", () => {
  it("preserves the order of semantic actions in a result", () => {
    const result: ModuleResult = {
      actions: [
        { kind: "chat", text: "Hallo", replyToMessageId: "message-1" },
        { kind: "overlay", type: "raid", elementKind: "raid.alert", payload: { viewers: 42 } },
      ],
      diagnostics: [],
    };

    expect(result.actions).toEqual([
      { kind: "chat", text: "Hallo", replyToMessageId: "message-1" },
      { kind: "overlay", type: "raid", elementKind: "raid.alert", payload: { viewers: 42 } },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("registers the clips module as default-enabled with a stream-live action", () => {
    expect(MODULES).toContain(clipsModule);
    expect(clipsModule.defaultEnabled).toBe(true);
    expect(clipsModule.immediateActions?.requires).toEqual(["streamLive"]);
  });

  describe("apiErrorDetail", () => {
    it("converts a nonempty twitchMessage into message for the API response", () => {
      expect(apiErrorDetail({ status: 429, twitchMessage: "slow down" }))
        .toEqual({ status: 429, message: "slow down" });
    });

    it("converts a null twitchMessage into message: null, instead of dropping the key (issue #201 follow-up)", () => {
      // A timeout/network error never had a Twitch body to read a message
      // from (`helixRequest` sets `message: null`) -- the converted key
      // still has to be `message: null`, matching what every API client
      // has always seen for that case, not simply absent.
      expect(apiErrorDetail({ status: null, twitchMessage: null }))
        .toEqual({ status: null, message: null });
    });

    it("leaves detail untouched when there's no twitchMessage key at all", () => {
      const detail = { status: 200 };
      expect(apiErrorDetail(detail)).toBe(detail);
    });

    it("leaves detail untouched when message is already present, twitchMessage included", () => {
      const detail = { message: "already set", twitchMessage: "ignored" };
      expect(apiErrorDetail(detail)).toBe(detail);
    });
  });

  describe("localMidnightInTimeZone", () => {
    it("returns the first instant of the day when Africa/Cairo's 2026 spring change skips local midnight", () => {
      // Cairo's DST switches clocks from 00:00 to 01:00 on this date, so 00:00 never occurs;
      // sun, moon, and text_library all route through this one helper for their local-midnight
      // math, so the DST fix here applies to every caller.
      const midnight = localMidnightInTimeZone("2026-04-24", "Africa/Cairo");
      expect(midnight).toBe("2026-04-23T22:00:00.000Z");
    });
  });

  describe("nextLocalMidnightInTimeZone", () => {
    it("returns the same Africa/Cairo 2026-04-24 instant as the next midnight after a moment on the previous day", () => {
      const from = Date.parse("2026-04-23T10:00:00.000Z");
      expect(nextLocalMidnightInTimeZone(from, "Africa/Cairo")).toBe(Date.parse("2026-04-23T22:00:00.000Z"));
    });
  });

  describe("wallTimeInstantsInTimeZone", () => {
    it("returns a single instant on a normal day", () => {
      expect(wallTimeInstantsInTimeZone("2026-06-21", "02:30", "Europe/Berlin"))
        .toEqual([Date.parse("2026-06-21T00:30:00.000Z")]);
    });

    it("returns the spring-forward transition itself for a wall time Europe/Berlin's clocks skip", () => {
      // 2026-03-29: Berlin clocks jump from 01:59:59 CET straight to 03:00:00 CEST, so
      // 02:30 never occurs; the boundary it was meant to mark takes effect at the jump.
      expect(wallTimeInstantsInTimeZone("2026-03-29", "02:30", "Europe/Berlin"))
        .toEqual([Date.parse("2026-03-29T01:00:00.000Z")]);
    });

    it("returns the spring-forward transition itself for a wall time Africa/Cairo's clocks skip", () => {
      // 2026-04-24: Cairo clocks jump from 23:59:59 (Apr 23) straight to 01:00:00
      // (Apr 24), skipping 00:00-00:59 on Apr 24 entirely; 00:30 never occurs.
      expect(wallTimeInstantsInTimeZone("2026-04-24", "00:30", "Africa/Cairo"))
        .toEqual([Date.parse("2026-04-23T22:00:00.000Z")]);
    });

    it("returns both instants for a wall time Europe/Berlin's fall-back replays", () => {
      // 2026-10-25: Berlin clocks fall back from 02:59:59 CEST to 02:00:00 CET, so
      // 02:30 occurs once under each offset.
      expect(wallTimeInstantsInTimeZone("2026-10-25", "02:30", "Europe/Berlin")).toEqual([
        Date.parse("2026-10-25T00:30:00.000Z"),
        Date.parse("2026-10-25T01:30:00.000Z"),
      ]);
    });

    it("returns both instants for a wall time America/Havana's fall-back replays", () => {
      // 2026-11-01: Havana clocks fall back from 00:59:59 to 00:00:00, so 00:30 occurs twice.
      expect(wallTimeInstantsInTimeZone("2026-11-01", "00:30", "America/Havana")).toEqual([
        Date.parse("2026-11-01T04:30:00.000Z"),
        Date.parse("2026-11-01T05:30:00.000Z"),
      ]);
    });
  });
});
