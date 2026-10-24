import { describe, expect, it } from "vitest";
import type { ModuleAlarmContext } from "../../src/modules/contract";
import { duelModule } from "../../src/modules/duel";
import { duelSettingsForLanguage } from "../../src/modules/duel/contracts";
import { duelTextVariables } from "../../src/modules/duel/service";

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

    expect([announcement?.kind === "silent" ? undefined : announcement?.text, accepted?.text].filter((line) => line !== undefined)).toHaveLength(2);
    expect([announcement?.kind === "silent" ? undefined : announcement?.text, botExpired?.text].filter((line) => line !== undefined)).toHaveLength(2);
    expect(announcement?.kind === "silent" ? "" : announcement?.text).toContain("challenges chat to a 100 point duel");
    expect(accepted?.text).toContain("moonmoss wins +100 points; frostfern loses −100 points");
    expect(botExpired?.text).toContain("BroBot wins +100 points; frostfern loses −100 points");
    expect(silentExpiry).toBeNull();
  });

  it("suppresses disabled saved announcements and results while keeping their templates", async () => {
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
      texts: { ...settings.texts, challengeOpenEnabled: false, resultEnabled: false },
    };
    const announcement = await duelModule.formatPointRoundAnnouncement?.(alarmContext, {
      roundId: "fictional-round", data, text: settings.texts.challengeOpen,
    });
    const result = await duelModule.formatPointRoundResult?.(alarmContext, {
      roundId: "fictional-round",
      data,
      result: { winner: "viewer_ben", winnerLogin: "moonmoss", loserLogin: "frostfern", net: 100, bot: false },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });

    expect(announcement).toEqual({ kind: "silent" });
    expect(result).toBeNull();
    expect(data.texts.challengeOpen).toBe(settings.texts.challengeOpen);
    expect(data.texts.result).toBe(settings.texts.result);
  });

  it("filters every fight variable when its selected variant is disabled", () => {
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
      fightText: "Disabled fight line",
      fightTextEnabled: false,
      botFightText: "Disabled bot fight line",
      botFightTextEnabled: false,
      texts: settings.texts,
    };

    expect(duelTextVariables(data)).toMatchObject({ fight: "", botFight: "" });
    expect(duelTextVariables(data, { fight: "" })).toMatchObject({ fight: "", botFight: "" });
  });

  it.each([
    [true, true], [true, false], [false, true], [false, false],
  ] as const)("keeps each result's fight line behind its own switch (human %s, bot %s)", async (humanOn, botOn) => {
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
      fightText: "HUMAN-FIGHT-LINE",
      fightTextEnabled: humanOn,
      botFightText: "BOT-FIGHT-LINE",
      botFightTextEnabled: botOn,
      texts: { ...settings.texts, result: "{winner} won. {fight}", botResult: "{winner} won. {fight}" },
    };
    const humanResult = await duelModule.formatPointRoundResult?.(alarmContext, {
      roundId: "fictional-round",
      data,
      result: { winner: "viewer_ben", winnerLogin: "moonmoss", loserLogin: "frostfern", net: 100, bot: false },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });
    const botResult = await duelModule.formatPointRoundResult?.(alarmContext, {
      roundId: "fictional-round",
      data,
      result: { winner: "bot", winnerLogin: "BroBot", loserLogin: "frostfern", net: -100, bot: true },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });

    expect(humanResult?.text).toBe(humanOn ? "moonmoss won. HUMAN-FIGHT-LINE" : "moonmoss won. ");
    expect(botResult?.text).toBe(botOn ? "BroBot won. BOT-FIGHT-LINE" : "BroBot won. ");
  });

  it.each([
    ["de", "🧹"],
    ["en", "janitor"],
  ] as const)("gives the bot result its own recognizable default in %s", (language, opponentCue) => {
    const { result, botResult } = duelSettingsForLanguage(language).texts;
    const placeholders = (template: string): string[] => [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)]
      .map((match) => match[1] ?? "")
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

    expect(botResult).not.toBe(result);
    expect(botResult).toContain(opponentCue);
    expect(placeholders(botResult)).toEqual(["fight", "loser", "loss", "net", "winner"]);
    expect(placeholders(botResult)).toEqual(placeholders(result));
  });
});
