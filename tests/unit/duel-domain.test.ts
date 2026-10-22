import { describe, expect, it } from "vitest";
import { parseDuelChallengeCommand, parseDuelAcceptCommand, validateDuelTarget } from "../../src/modules/duel/domain/command";
import { duelSettingsSchema, duelSettingsForLanguage } from "../../src/modules/duel/contracts";

const settings = { challengeCommand: "!duell", acceptCommand: "!ja", defaultStake: 50, minStake: 10, maxStake: 1_000 };

describe("duel command rules", () => {
  it("parses a targeted stake and a public challenge [protects=both command forms retain their intended target and stake; fails_when=@login is parsed as a stake or an open challenge invents a target; no_claim=the Twitch account lookup and DO locks remain integration concerns]", () => {
    expect(parseDuelChallengeCommand("!duell @viewer_b 100", settings)).toEqual({ ok: true, targetLogin: "viewer_b", stake: 100 });
    expect(parseDuelChallengeCommand("!duell 100", settings)).toEqual({ ok: true, targetLogin: null, stake: 100 });
  });

  it("uses the configured stake when it is omitted [protects=an omitted stake uses the saved default; fails_when=the parser requires a stake or uses a hard-coded value; no_claim=the settings value itself is loaded from D1]", () => {
    expect(parseDuelChallengeCommand("!duell", settings)).toEqual({ ok: true, targetLogin: null, stake: 50 });
    expect(parseDuelChallengeCommand("!duell @viewer_b", settings)).toEqual({ ok: true, targetLogin: "viewer_b", stake: 50 });
  });

  it("rejects zero and non-integer stakes [protects=challenge stakes are positive whole numbers; fails_when=zero, fractions, signs, or trailing text are accepted; no_claim=chat error wording and throttle are tested in the module worker suite]", () => {
    expect(parseDuelChallengeCommand("!duell 0", settings)).toEqual({ ok: false, reason: "invalid_stake" });
    expect(parseDuelChallengeCommand("!duell 10.5", settings)).toEqual({ ok: false, reason: "invalid_stake" });
    expect(parseDuelChallengeCommand("!duell +10", settings)).toEqual({ ok: false, reason: "invalid_stake" });
  });

  it("reports out-of-range stakes without changing the parsed amount [protects=min and max are applied to explicit stakes; fails_when=an out-of-bounds integer becomes a playable challenge; no_claim=the user-facing localized min/max text is tested through the service]", () => {
    expect(parseDuelChallengeCommand("!duell 9", settings)).toEqual({ ok: false, reason: "out_of_range" });
    expect(parseDuelChallengeCommand("!duell 1001", settings)).toEqual({ ok: false, reason: "out_of_range" });
  });

  it("rejects a self-target after Twitch resolves the login [protects=the same account cannot escrow a targeted duel against itself; fails_when=equal challenger and target IDs pass validation; no_claim=Twitch login canonicalization is outside this pure rule]", () => {
    expect(validateDuelTarget("viewer_anna", "viewer_anna")).toBe("self_target");
    expect(validateDuelTarget("viewer_anna", "viewer_ben")).toBeNull();
  });

  it("matches only the configured accept command [protects=accept parsing requires one exact command token; fails_when=arguments or a different command trigger acceptance; no_claim=round selection and acceptance eligibility are covered by worker tests]", () => {
    expect(parseDuelAcceptCommand("!ja", "!ja")).toBe(true);
    expect(parseDuelAcceptCommand("!ja extra", "!ja")).toBe(false);
    expect(parseDuelAcceptCommand("!yes", "!ja")).toBe(false);
  });
});

describe("duel settings", () => {
  it("accepts the default stake inside its configured bounds [protects=the documented default min, default, and max form a valid saved configuration; fails_when=valid defaults fail validation; no_claim=dashboard rendering and server persistence are tested elsewhere]", () => {
    expect(duelSettingsSchema.safeParse(duelSettingsForLanguage("de")).success).toBe(true);
    expect(duelSettingsForLanguage("de").challengeCommand).toBe("!duell");
    expect(duelSettingsForLanguage("en").challengeCommand).toBe("!duel");
    expect(duelSettingsForLanguage("en").acceptCommand).toBe("!yes");
  });

  it("rejects invalid stake ordering and identical command names [protects=min ≤ default ≤ max and distinct command tokens; fails_when=an invalid range or command pair can be saved; no_claim=collision with commands from other enabled modules is a route-level check]", () => {
    const defaults = duelSettingsForLanguage("de");
    expect(duelSettingsSchema.safeParse({ ...defaults, minStake: 60 }).success).toBe(false);
    expect(duelSettingsSchema.safeParse({ ...defaults, maxStake: 100_001 }).success).toBe(false);
    expect(duelSettingsSchema.safeParse({ ...defaults, acceptCommand: defaults.challengeCommand }).success).toBe(false);
  });
});
