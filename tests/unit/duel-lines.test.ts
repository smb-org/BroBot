import { describe, expect, it } from "vitest";
import type { ModuleAlarmContext } from "../../src/modules/contract";
import { duelModule } from "../../src/modules/duel";
import { duelSettingsForLanguage } from "../../src/modules/duel/contracts";

const alarmContext = {
  renderTemplate: (text: string, values: Record<string, string | number> = {}) => Promise.resolve({
    text: text.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) =>
      values[name] === undefined ? match : String(values[name])),
  }),
} as unknown as ModuleAlarmContext;

describe("duel round chat line budget", () => {
  it("emits at most one announcement and one result line per path [protects=the persisted round produces no more than two challenge lines; fails_when=a challenge, accept result, or bot expiry emits an extra round line; no_claim=the host send adapter and Twitch delivery are mocked by the module alarm worker tests]", async () => {
    const settings = duelSettingsForLanguage("en");
    const data = {
      challengerId: "viewer_anna",
      challengerLogin: "frostfern",
      targetId: null,
      targetLogin: null,
      stake: 100,
      botEnabled: true,
      acceptCommand: "!yes",
      language: "en" as const,
      chatTarget: null,
      sourceBroadcasterUserId: null,
      challengeMessageId: "fictional-challenge-message",
      fightText: settings.texts.fightVariants[0] ?? "",
      botFightText: settings.texts.botFightVariants[0] ?? "",
      texts: settings.texts,
    };
    const announcement = await duelModule.formatPointRoundAnnouncement?.(alarmContext, {
      roundId: "fictional-round",
      data,
      text: settings.texts.challengeOpen,
    });
    const accepted = await duelModule.formatPointRoundResult?.(alarmContext, {
      roundId: "fictional-round",
      data,
      result: { winner: "viewer_ben", winnerLogin: "moonmoss", loserLogin: "frostfern", net: 100, bot: false },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });
    const botExpired = await duelModule.formatPointRoundResult?.(alarmContext, {
      roundId: "fictional-round",
      data,
      result: { winner: "bot", winnerLogin: "BroBot", loserLogin: "frostfern", net: -100, bot: true },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });
    const silentExpiry = await duelModule.formatPointRoundResult?.(alarmContext, {
      roundId: "fictional-round",
      data: { ...data, targetId: "viewer_ben", targetLogin: "moonmoss" },
      result: { expired: true },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });

    expect([announcement?.text, accepted?.text].filter((line) => line !== undefined)).toHaveLength(2);
    expect([announcement?.text, botExpired?.text].filter((line) => line !== undefined)).toHaveLength(2);
    expect(announcement?.text).toContain("challenges chat to a 100 point duel");
    expect(accepted?.text).toContain("moonmoss wins +100 points; frostfern loses −100 points");
    expect(botExpired?.text).toContain("BroBot wins +100 points; frostfern loses −100 points");
    expect(silentExpiry).toBeNull();
  });
});
