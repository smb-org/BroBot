import type { ModuleEvent, ModuleExecutionContext, ModuleLanguage, ModulePointsAccess, ModuleResult } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import {
  BOSS_FIGHT_BASE_HP,
  BOSS_FIGHT_HP_PER_ATTACKER,
  BOSS_FIGHT_MODULE_ID,
  bossFightSettingsReadSchema,
} from "./contracts";
import type { BossFightRoundData, BossFightSettings } from "./contracts";
import { rollBossDamage } from "./domain/boss";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const loadEnabledBossFightSettings = async (db: D1Database, channelId: string): Promise<BossFightSettings | null> => {
  const row = await db.prepare(
    "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ? AND enabled = 1",
  ).bind(channelId, BOSS_FIGHT_MODULE_ID).first<{ settings: string }>();
  if (row === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.settings);
    const settings = bossFightSettingsReadSchema.safeParse(parsed);
    return settings.success ? settings.data : null;
  } catch {
    return null;
  }
};

export const openBossFightRound = async (input: {
  settings: BossFightSettings;
  language: ModuleLanguage;
  points: ModulePointsAccess;
}): Promise<string> => {
  const roundId = crypto.randomUUID();
  const data: BossFightRoundData = {
    durationSeconds: input.settings.durationSeconds,
    baseHp: BOSS_FIGHT_BASE_HP,
    hpPerAttacker: BOSS_FIGHT_HP_PER_ATTACKER,
    damageMinimum: input.settings.damageMinimum,
    damageMaximum: input.settings.damageMaximum,
    attackCooldownSeconds: input.settings.attackCooldownSeconds,
    lootPool: input.settings.lootPool,
    language: input.language,
    chatTarget: input.settings.chatTarget,
    startText: input.settings.startText,
    ...(input.settings.startTextEnabled === undefined ? {} : { startTextEnabled: input.settings.startTextEnabled }),
    defeatedText: input.settings.defeatedText,
    ...(input.settings.defeatedTextEnabled === undefined ? {} : { defeatedTextEnabled: input.settings.defeatedTextEnabled }),
    timeoutText: input.settings.timeoutText,
    ...(input.settings.timeoutTextEnabled === undefined ? {} : { timeoutTextEnabled: input.settings.timeoutTextEnabled }),
    attackerCount: 0,
    damageDealt: 0,
    maxHp: BOSS_FIGHT_BASE_HP,
    currentHp: BOSS_FIGHT_BASE_HP,
    defeated: false,
  };
  const announce = isMessageEnabled(input.settings, "startText", "startTextEnabled");
  await input.points.rounds.open(roundId, {
    ...data,
    durationS: input.settings.durationSeconds,
    durationSeconds: input.settings.durationSeconds,
    announceText: announce ? input.settings.startText : "",
    silentAnnouncement: !announce,
    settlement: { kind: BOSS_FIGHT_MODULE_ID, params: {} },
  });
  return roundId;
};

export const bossAttackOperationId = async (roundId: string, accountId: string, messageId: string): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify([roundId, accountId, messageId]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const suffix = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `round:${roundId}:attack:${suffix}`;
};

export const processBossFightMessage = async (
  event: ModuleEvent<BossFightSettings>,
  context: ModuleExecutionContext,
  random: () => number = Math.random,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return { actions: [], diagnostics: [] };
  const payload = event.payload;
  const userId = payload.chatter_user_id;
  const login = payload.chatter_user_login;
  const messageId = payload.message_id;
  const message = record(payload.message)?.text;
  if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/u.test(userId) || typeof login !== "string" ||
      !/^[A-Za-z0-9_]{1,25}$/u.test(login) || typeof messageId !== "string" || messageId.length === 0 ||
      typeof message !== "string" || message.trim().toLocaleLowerCase("en-US") !== "!attack") {
    return { actions: [], diagnostics: [] };
  }
  if (await context.botUserId?.() === userId) return { actions: [], diagnostics: [] };
  const sourceBroadcasterId = payload.source_broadcaster_user_id;
  if (typeof sourceBroadcasterId === "string" && sourceBroadcasterId !== event.channelId) return { actions: [], diagnostics: [] };
  const active = await context.points.rounds.active();
  if (active === null || active.state !== "open" || active.deadlineAt === null || active.deadlineAt <= Date.now()) {
    return { actions: [], diagnostics: [] };
  }
  const data = record(active.data);
  if (data === null || !Number.isSafeInteger(data.damageMinimum) || !Number.isSafeInteger(data.damageMaximum) ||
      !Number.isSafeInteger(data.attackCooldownSeconds)) return { actions: [], diagnostics: [] };
  const messageAt = Date.parse(event.eventSubTimestamp ?? event.receivedAt);
  if (!Number.isSafeInteger(messageAt) || messageAt < 0 || messageAt > Date.now() + 5_000) return { actions: [], diagnostics: [] };
  let damage: number;
  try {
    damage = rollBossDamage(data.damageMinimum as number, data.damageMaximum as number, random);
  } catch {
    return { actions: [], diagnostics: [] };
  }
  const operationId = await bossAttackOperationId(active.roundId, userId, messageId);
  const result = await context.points.rounds.attack(
    active.roundId,
    operationId,
    userId,
    login,
    damage,
    messageAt,
  );
  if (result.status === "hit" && result.defeated) {
    try {
      await context.points.rounds.resolve(active.roundId, { kind: BOSS_FIGHT_MODULE_ID, params: {} });
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      if (code !== "round_closed" && code !== "round_cancellation_pending" && code !== "module_closed") throw error;
    }
  }
  return { actions: [], diagnostics: [] };
};

