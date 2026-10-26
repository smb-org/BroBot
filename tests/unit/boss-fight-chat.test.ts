import { describe, expect, it, vi } from "vitest";
import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import type { BossFightSettings } from "../../src/modules/boss_fight/contracts";
import { formatBossOutcomeLine, formatBossStartLine } from "../../src/modules/boss_fight/locale";
import { truncateChatTextWithAttributions } from "../../src/worker/chat";
import { bossFightDefaultsForLanguage } from "../../src/modules/boss_fight/contracts";
import { bossAttackOperationId, processBossFightMessage } from "../../src/modules/boss_fight/service";

const event = (text: string): ModuleEvent<BossFightSettings> => ({
  triggerId: "fictional-trigger",
  settings: bossFightDefaultsForLanguage("en"),
  receivedAt: new Date().toISOString(),
  actor: null,
  chatStatus: ["viewer"],
  subscriptionType: "channel.chat.message",
  channelId: "fictional_channel",
  payload: { chatter_user_id: "viewer_one", chatter_user_login: "frostfern", message_id: "message-one", message: { text } },
});

describe("boss fight chat output", () => {
  it("records an attack without replying to the viewer", async () => {
    const attack = vi.fn(() => Promise.resolve({
      status: "hit" as const,
      replayed: false,
      damage: 30,
      defeated: false,
      currentHp: 350,
      maxHp: 380,
      attackers: 1,
      damageDealt: 30,
    }));
    const active = vi.fn(() => Promise.resolve({
      roundId: "boss-round",
      state: "open" as const,
      deadlineAt: Date.now() + 90_000,
      data: { baseHp: 300, hpPerAttacker: 80, damageMinimum: 20, damageMaximum: 40, attackCooldownSeconds: 10 },
    }));
    const context = {
      points: { rounds: { active, attack } },
      botUserId: () => Promise.resolve("fictional_bot"),
    } as unknown as ModuleExecutionContext;

    const input = event("!attack");
    const operationId = await bossAttackOperationId("boss-round", "viewer_one", "message-one");
    await expect(processBossFightMessage(input, context, () => 0.5)).resolves.toEqual({ actions: [], diagnostics: [] });
    expect(active).toHaveBeenCalledOnce();
    expect(attack).toHaveBeenCalledExactlyOnceWith("boss-round", operationId, "viewer_one", "frostfern", 30, Date.parse(input.receivedAt));
  });

  it("uses one bounded result line with only the top damage dealers", () => {
    const line = formatBossOutcomeLine({
      language: "en",
      summary: "🏆 The boss is\ndefeated!",
      topDamageDealers: [
        { login: "frostfern", damage: 120, amount: 400 },
        { login: "moonmoss", damage: 100, amount: 333 },
        { login: "pixelpilz", damage: 80, amount: 266 },
        { login: "amberleaf", damage: 60, amount: 0 },
      ],
      otherCount: 1,
    });

    expect(line).toContain("frostfern");
    expect(line).toContain("moonmoss");
    expect(line).toContain("+1 more");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("amberleaf");
    expect(line.length).toBeLessThanOrEqual(500);
  });

  it("keeps the attack hint, duration and top damage intact when a long custom text meets attributions [protects=the mandatory part of each line is reserved before the custom text and the host attributions are added; fails_when=the attribution suffix cuts off !attack, the duration or the top damage; no_claim=attribution wording comes from the template sources]", () => {
    const attributions = ["Weather data by Fictional Source", "Quotes by Another Fictional Source"];
    const longText = "A very long boss story. ".repeat(40);
    const start = truncateChatTextWithAttributions(
      formatBossStartLine({ language: "en", summary: longText, durationSeconds: 90, attributions }),
      attributions,
    );
    const result = truncateChatTextWithAttributions(
      formatBossOutcomeLine({
        language: "en",
        summary: longText,
        topDamageDealers: [{ login: "frostfern", damage: 120, amount: 400 }],
        otherCount: 0,
        attributions,
      }),
      attributions,
    );

    expect(start.truncated).toBe(false);
    expect(start.text).toContain("Type !attack to hit the boss. (90 s)");
    expect(start.text.endsWith(" · Quotes by Another Fictional Source")).toBe(true);
    expect(start.text.length).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("@frostfern 120 dmg · 400 pts.");
    expect(result.text.length).toBeLessThanOrEqual(500);
  });
});
