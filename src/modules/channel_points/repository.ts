import type {
  ChannelPointsRedemption, ChannelPointsRedemptionStatus, ChannelPointsReward, ChannelPointsRewardInput,
  TwitchRedemptionStatus,
} from "./contracts";

interface RewardRow {
  id: string; twitch_reward_id: string; title: string; prompt: string | null; cost: number;
  background_color: string | null; is_user_input_required: number; global_cooldown_seconds: number | null;
  max_per_stream: number | null; max_per_user_per_stream: number | null; action_module_id: string;
  action_id: string; action_config_json: string; mode: "auto" | "queue"; enabled: number;
  twitch_state: "creating" | "active" | "deleted_on_twitch"; created_at: string; updated_at: string;
}
interface RedemptionRow {
  redemption_id: string; reward_id: string; twitch_reward_id: string; reward_title: string; user_id: string; user_login: string;
  user_name: string; user_input: string; redeemed_at: string; status: ChannelPointsRedemptionStatus;
  pending_twitch_status: TwitchRedemptionStatus | null; outcome_reason_json: string | null; claimed_at: string | null;
  created_at: string; updated_at: string;
}
const rewardFromRow = (row: RewardRow): ChannelPointsReward => ({
  id: row.id, twitchRewardId: row.twitch_reward_id, title: row.title, prompt: row.prompt, cost: row.cost,
  backgroundColor: row.background_color, isUserInputRequired: row.is_user_input_required === 1,
  globalCooldownSeconds: row.global_cooldown_seconds, maxPerStream: row.max_per_stream,
  maxPerUserPerStream: row.max_per_user_per_stream, actionModuleId: row.action_module_id, actionId: row.action_id,
  actionConfig: JSON.parse(row.action_config_json) as Record<string, unknown>, mode: row.mode,
  enabled: row.enabled === 1, twitchState: row.twitch_state, createdAt: row.created_at, updatedAt: row.updated_at,
});
const redemptionFromRow = (row: RedemptionRow): ChannelPointsRedemption => ({
  redemptionId: row.redemption_id, rewardId: row.reward_id, twitchRewardId: row.twitch_reward_id, rewardTitle: row.reward_title,
  userId: row.user_id, userLogin: row.user_login, userName: row.user_name, userInput: row.user_input,
  redeemedAt: row.redeemed_at, status: row.status, pendingTwitchStatus: row.pending_twitch_status,
  outcomeReason: row.outcome_reason_json === null ? null : JSON.parse(row.outcome_reason_json) as { de: string; en: string },
  createdAt: row.created_at, updatedAt: row.updated_at,
});
export interface ChannelPointsRepository {
  listRewards(channelId: string): Promise<ChannelPointsReward[]>;
  getReward(channelId: string, id: string): Promise<ChannelPointsReward | null>;
  getRewardByTwitchId(channelId: string, id: string): Promise<ChannelPointsReward | null>;
  insertReward(channelId: string, reward: ChannelPointsRewardInput, id: string, twitchRewardId: string, now: string, guard?: { sql: string; values: readonly (string | number | null)[] }): Promise<boolean>;
  insertCreatingReward(channelId: string, reward: ChannelPointsRewardInput, id: string, now: string, guard: { sql: string; values: readonly (string | number | null)[] }): Promise<boolean>;
  finalizeCreatingReward(channelId: string, id: string, twitchRewardId: string, now: string, guard: { sql: string; values: readonly (string | number | null)[] }): Promise<boolean>;
  adoptCreatingReward(channelId: string, id: string, reward: { twitchRewardId: string; title: string; prompt: string | null; cost: number; backgroundColor: string | null; isUserInputRequired: boolean; globalCooldownSeconds: number | null; maxPerStream: number | null; maxPerUserPerStream: number | null; isEnabled: boolean }, now: string): Promise<boolean>;
  deleteCreatingReward(channelId: string, id: string): Promise<boolean>;
  updateReward(channelId: string, id: string, reward: ChannelPointsRewardInput, now: string, guard?: { sql: string; values: readonly (string | number | null)[] }): Promise<boolean>;
  adoptTwitchReward(channelId: string, reward: { id: string; title: string; prompt: string | null; cost: number; backgroundColor: string | null; isUserInputRequired: boolean; globalCooldownSeconds: number | null; maxPerStream: number | null; maxPerUserPerStream: number | null; isEnabled: boolean }, now: string, eventAt?: string): Promise<boolean>;
  markRewardDeleted(channelId: string, twitchRewardId: string, now: string, eventAt?: string): Promise<boolean>;
  orphanOpenRedemptions(channelId: string, twitchRewardId: string, outcomeReason: { de: string; en: string }, now: string): Promise<number>;
  deleteReward(channelId: string, id: string, guard?: { sql: string; values: readonly (string | number | null)[] }): Promise<boolean>;
  replaceTwitchId(channelId: string, id: string, twitchRewardId: string, now: string, guard?: { sql: string; values: readonly (string | number | null)[] }): Promise<boolean>;
  latchRedemption(channelId: string, redemption: {
    id: string; rewardId: string; twitchRewardId: string; rewardTitle: string; userId: string; userLogin: string; userName: string;
    userInput: string; redeemedAt: string; initialStatus?: "queued" | "fulfilled" | "refunded" | "orphaned";
    initialOutcomeReason?: { de: string; en: string } | null;
  }, now: string): Promise<boolean>;
  getRedemption(channelId: string, id: string): Promise<ChannelPointsRedemption | null>;
  updateRedemption(channelId: string, id: string, change: { status: ChannelPointsRedemptionStatus; pendingTwitchStatus?: TwitchRedemptionStatus | null; outcomeReason?: { de: string; en: string } | null; claimedAt?: string | null }, fromStatuses: readonly ChannelPointsRedemptionStatus[], now: string): Promise<boolean>;
  claimRedemption(
    channelId: string,
    id: string,
    fromStatuses: readonly ChannelPointsRedemptionStatus[],
    expiredBefore: string,
    now: string,
    guard?: { sql: string; values: readonly (string | number | null)[] },
  ): Promise<boolean>;
  reclaimRunningRedemption(channelId: string, id: string, expiredBefore: string, now: string): Promise<boolean>;
  claimFailedPatch(channelId: string, id: string, expiredBefore: string, now: string): Promise<boolean>;
  listRedemptions(channelId: string, cursor: string | null, limit: number): Promise<{ items: ChannelPointsRedemption[]; cursor: string | null }>;
  listQueuedRedemptions(channelId: string, limit: number): Promise<Array<{
    redemption: ChannelPointsRedemption;
    actionModuleId: string;
    actionId: string;
  }>>;
  listRetryable(channelId: string, expiredBefore: string): Promise<ChannelPointsRedemption[]>;
  listOpenRedemptions(channelId: string, expiredBefore: string): Promise<ChannelPointsRedemption[]>;
  persistReconcileTime(channelId: string, now: string): Promise<void>;
  lastReconciledAt(channelId: string): Promise<string | null>;
}
const decodeCursor = (cursor: string | null): { at: string; id: string } | null => {
  if (cursor === null) return null;
  const separator = cursor.indexOf("~");
  return separator < 1 ? null : { at: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
};
export const createChannelPointsRepository = (db: D1Database): ChannelPointsRepository => ({
  async listRewards(channelId) {
    const rows = await db.prepare("SELECT * FROM channel_points_rewards WHERE channel_id = ? ORDER BY created_at DESC, id")
      .bind(channelId).all<RewardRow>();
    return rows.results.map(rewardFromRow);
  },
  async getReward(channelId, id) {
    const row = await db.prepare("SELECT * FROM channel_points_rewards WHERE channel_id = ? AND id = ?").bind(channelId, id).first<RewardRow>();
    return row === null ? null : rewardFromRow(row);
  },
  async getRewardByTwitchId(channelId, id) {
    const row = await db.prepare("SELECT * FROM channel_points_rewards WHERE channel_id = ? AND twitch_reward_id = ?").bind(channelId, id).first<RewardRow>();
    return row === null ? null : rewardFromRow(row);
  },
  async insertReward(channelId, reward, id, twitchRewardId, now, guard) {
    const authorization = guard === undefined ? "" : ` WHERE EXISTS (SELECT 1 FROM channels WHERE channel_id = ? ${guard.sql})`;
    const result = await db.prepare(`INSERT INTO channel_points_rewards (channel_id,id,twitch_reward_id,title,prompt,cost,background_color,is_user_input_required,global_cooldown_seconds,max_per_stream,max_per_user_per_stream,action_module_id,action_id,action_config_json,mode,enabled,last_twitch_event_at,twitch_state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?${authorization}`)
      .bind(channelId, id, twitchRewardId, reward.title, reward.prompt, reward.cost, reward.backgroundColor,
        Number(reward.isUserInputRequired), reward.globalCooldownSeconds, reward.maxPerStream, reward.maxPerUserPerStream,
        reward.actionModuleId, reward.actionId, JSON.stringify(reward.actionConfig), reward.mode, Number(reward.enabled), now, now, now,
        ...(guard === undefined ? [] : [channelId, ...guard.values])).run();
    return result.meta.changes > 0;
  },
  async insertCreatingReward(channelId, reward, id, now, guard) {
    const result = await db.prepare(`INSERT INTO channel_points_rewards (channel_id,id,twitch_reward_id,title,prompt,cost,background_color,is_user_input_required,global_cooldown_seconds,max_per_stream,max_per_user_per_stream,action_module_id,action_id,action_config_json,mode,enabled,last_twitch_event_at,twitch_state,created_at,updated_at)
      SELECT ?,?,'creating:'||?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'creating',?,? WHERE EXISTS (SELECT 1 FROM channels WHERE channel_id=? ${guard.sql})`)
      .bind(channelId, id, id, reward.title, reward.prompt, reward.cost, reward.backgroundColor,
        Number(reward.isUserInputRequired), reward.globalCooldownSeconds, reward.maxPerStream, reward.maxPerUserPerStream,
        reward.actionModuleId, reward.actionId, JSON.stringify(reward.actionConfig), reward.mode, Number(reward.enabled),
        now, now, now, channelId, ...guard.values).run();
    return result.meta.changes > 0;
  },
  async finalizeCreatingReward(channelId, id, twitchRewardId, now, guard) {
    const result = await db.prepare(`UPDATE channel_points_rewards
      SET twitch_reward_id=?,twitch_state='active',last_twitch_event_at=?,updated_at=?
      WHERE channel_id=? AND id=? AND twitch_state='creating'
        AND EXISTS (SELECT 1 FROM channels WHERE channel_id=? ${guard.sql})`)
      .bind(twitchRewardId, now, now, channelId, id, channelId, ...guard.values).run();
    return result.meta.changes > 0;
  },
  async adoptCreatingReward(channelId, id, reward, now) {
    const result = await db.prepare(`UPDATE channel_points_rewards
      SET twitch_reward_id=?,title=?,prompt=?,cost=?,background_color=?,is_user_input_required=?,
          global_cooldown_seconds=?,max_per_stream=?,max_per_user_per_stream=?,enabled=?,
          last_twitch_event_at=?,twitch_state='active',updated_at=?
      WHERE channel_id=? AND id=? AND twitch_state='creating'`)
      .bind(reward.twitchRewardId, reward.title, reward.prompt, reward.cost, reward.backgroundColor,
        Number(reward.isUserInputRequired), reward.globalCooldownSeconds, reward.maxPerStream,
        reward.maxPerUserPerStream, Number(reward.isEnabled), now, now, channelId, id).run();
    return result.meta.changes > 0;
  },
  async deleteCreatingReward(channelId, id) {
    const result = await db.prepare("DELETE FROM channel_points_rewards WHERE channel_id=? AND id=? AND twitch_state='creating'")
      .bind(channelId, id).run();
    return result.meta.changes > 0;
  },
  async updateReward(channelId, id, reward, now, guard) {
    const authorization = guard === undefined ? "" : ` AND EXISTS (SELECT 1 FROM channels WHERE channel_id = ? ${guard.sql})`;
    const result = await db.prepare(`UPDATE channel_points_rewards SET title=?,prompt=?,cost=?,background_color=?,is_user_input_required=?,global_cooldown_seconds=?,max_per_stream=?,max_per_user_per_stream=?,action_module_id=?,action_id=?,action_config_json=?,mode=?,enabled=?,last_twitch_event_at=?,updated_at=? WHERE channel_id=? AND id=?${authorization}`)
      .bind(reward.title, reward.prompt, reward.cost, reward.backgroundColor, Number(reward.isUserInputRequired),
        reward.globalCooldownSeconds, reward.maxPerStream, reward.maxPerUserPerStream, reward.actionModuleId,
        reward.actionId, JSON.stringify(reward.actionConfig), reward.mode, Number(reward.enabled), now, now, channelId, id,
        ...(guard === undefined ? [] : [channelId, ...guard.values])).run();
    return result.meta.changes > 0;
  },
  async adoptTwitchReward(channelId, reward, now, eventAt) {
    const ordering = eventAt === undefined ? "" : " AND twitch_state = 'active' AND (last_twitch_event_at IS NULL OR last_twitch_event_at <= ?)";
    const result = await db.prepare(`UPDATE channel_points_rewards SET title=?,prompt=?,cost=?,background_color=?,is_user_input_required=?,global_cooldown_seconds=?,max_per_stream=?,max_per_user_per_stream=?,enabled=?,last_twitch_event_at=?,updated_at=? WHERE channel_id=? AND twitch_reward_id=?${ordering}`)
      .bind(reward.title, reward.prompt, reward.cost, reward.backgroundColor, Number(reward.isUserInputRequired),
        reward.globalCooldownSeconds, reward.maxPerStream, reward.maxPerUserPerStream, Number(reward.isEnabled),
        eventAt ?? now, now, channelId, reward.id, ...(eventAt === undefined ? [] : [eventAt])).run();
    return result.meta.changes > 0;
  },
  async markRewardDeleted(channelId, twitchRewardId, now, eventAt) {
    const ordering = eventAt === undefined ? "" : " AND (last_twitch_event_at IS NULL OR last_twitch_event_at <= ?)";
    const result = await db.prepare(`UPDATE channel_points_rewards SET twitch_state='deleted_on_twitch',last_twitch_event_at=?,updated_at=? WHERE channel_id=? AND twitch_reward_id=?${ordering}`)
      .bind(eventAt ?? now, now, channelId, twitchRewardId, ...(eventAt === undefined ? [] : [eventAt])).run();
    return result.meta.changes > 0;
  },
  async orphanOpenRedemptions(channelId, twitchRewardId, outcomeReason, now) {
    const result = await db.prepare(`UPDATE channel_points_redemptions
      SET status='orphaned',pending_twitch_status=NULL,outcome_reason_json=?,claimed_at=NULL,updated_at=?
      WHERE channel_id=? AND twitch_reward_id=?
        AND status IN ('received','running','queued','pending','failed_to_update')`)
      .bind(JSON.stringify(outcomeReason), now, channelId, twitchRewardId).run();
    return result.meta.changes;
  },
  async deleteReward(channelId, id, guard) {
    const authorization = guard === undefined ? "" : ` AND EXISTS (SELECT 1 FROM channels WHERE channel_id = ? ${guard.sql})`;
    const result = await db.prepare(`DELETE FROM channel_points_rewards WHERE channel_id=? AND id=?${authorization}`)
      .bind(channelId, id, ...(guard === undefined ? [] : [channelId, ...guard.values])).run();
    return result.meta.changes > 0;
  },
  async replaceTwitchId(channelId, id, twitchRewardId, now, guard) {
    const authorization = guard === undefined ? "" : ` AND EXISTS (SELECT 1 FROM channels WHERE channel_id = ? ${guard.sql})`;
    const result = await db.prepare(`UPDATE channel_points_rewards SET twitch_reward_id=?,twitch_state='active',last_twitch_event_at=?,updated_at=? WHERE channel_id=? AND id=?${authorization}`)
      .bind(twitchRewardId, now, now, channelId, id, ...(guard === undefined ? [] : [channelId, ...guard.values])).run();
    return result.meta.changes > 0;
  },
  async latchRedemption(channelId, redemption, now) {
    const result = await db.prepare("INSERT OR IGNORE INTO channel_points_redemptions (channel_id,redemption_id,reward_id,twitch_reward_id,reward_title,user_id,user_login,user_name,user_input,redeemed_at,status,outcome_reason_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(channelId, redemption.id, redemption.rewardId, redemption.twitchRewardId, redemption.rewardTitle, redemption.userId, redemption.userLogin,
        redemption.userName, redemption.userInput, redemption.redeemedAt, redemption.initialStatus ?? "received",
        redemption.initialOutcomeReason === undefined || redemption.initialOutcomeReason === null
          ? null : JSON.stringify(redemption.initialOutcomeReason), now, now).run();
    return result.meta.changes > 0;
  },
  async getRedemption(channelId, id) {
    const row = await db.prepare("SELECT * FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?").bind(channelId, id).first<RedemptionRow>();
    return row === null ? null : redemptionFromRow(row);
  },
  async updateRedemption(channelId, id, change, fromStatuses, now) {
    if (fromStatuses.length === 0) return false;
    const placeholders = fromStatuses.map(() => "?").join(",");
    const result = await db.prepare(`UPDATE channel_points_redemptions SET status=?,pending_twitch_status=?,outcome_reason_json=?,claimed_at=?,updated_at=? WHERE channel_id=? AND redemption_id=? AND status IN (${placeholders})`)
      .bind(change.status, change.pendingTwitchStatus ?? null,
        change.outcomeReason === undefined || change.outcomeReason === null ? null : JSON.stringify(change.outcomeReason),
        change.claimedAt ?? null, now, channelId, id, ...fromStatuses).run();
    return result.meta.changes > 0;
  },
  async claimRedemption(channelId, id, fromStatuses, expiredBefore, now, guard) {
    if (fromStatuses.length === 0) return false;
    const placeholders = fromStatuses.map(() => "?").join(",");
    const authorization = guard === undefined ? "" :
      " AND EXISTS (SELECT channel_id FROM channels WHERE channel_id=? " + guard.sql + ")";
    const result = await db.prepare(`UPDATE channel_points_redemptions
      SET status='running',pending_twitch_status=NULL,claimed_at=?,updated_at=?
      WHERE channel_id=? AND redemption_id=? AND status IN (${placeholders})
        AND (status NOT IN ('pending','queued') OR claimed_at IS NULL OR claimed_at<=?)${authorization}`)
      .bind(now, now, channelId, id, ...fromStatuses, expiredBefore,
        ...(guard === undefined ? [] : [channelId, ...guard.values])).run();
    return result.meta.changes > 0;
  },
  async reclaimRunningRedemption(channelId, id, expiredBefore, now) {
    const result = await db.prepare("UPDATE channel_points_redemptions SET claimed_at=?,updated_at=? WHERE channel_id=? AND redemption_id=? AND status IN ('running') AND (claimed_at IS NULL OR claimed_at<=?)")
      .bind(now, now, channelId, id, expiredBefore).run();
    return result.meta.changes > 0;
  },
  async claimFailedPatch(channelId, id, expiredBefore, now) {
    const result = await db.prepare("UPDATE channel_points_redemptions SET claimed_at=?,updated_at=? WHERE channel_id=? AND redemption_id=? AND status IN ('failed_to_update') AND pending_twitch_status IS NOT NULL AND (claimed_at IS NULL OR claimed_at<=?)")
      .bind(now, now, channelId, id, expiredBefore).run();
    return result.meta.changes > 0;
  },
  async listRedemptions(channelId, cursor, limit) {
    const decoded = decodeCursor(cursor);
    const statement = decoded === null
      ? db.prepare("SELECT * FROM channel_points_redemptions WHERE channel_id=? ORDER BY redeemed_at DESC,redemption_id DESC LIMIT ?").bind(channelId, limit + 1)
      : db.prepare("SELECT * FROM channel_points_redemptions WHERE channel_id=? AND (redeemed_at<? OR (redeemed_at=? AND redemption_id<?)) ORDER BY redeemed_at DESC,redemption_id DESC LIMIT ?")
        .bind(channelId, decoded.at, decoded.at, decoded.id, limit + 1);
    const rows = await statement.all<RedemptionRow>();
    const hasMore = rows.results.length > limit;
    const items = rows.results.slice(0, limit).map(redemptionFromRow);
    const last = items.at(-1);
    return { items, cursor: hasMore && last !== undefined ? last.redeemedAt + "~" + last.redemptionId : null };
  },
  async listQueuedRedemptions(channelId, limit) {
    const rows = await db.prepare(`SELECT redemptions.*, rewards.action_module_id, rewards.action_id
      FROM channel_points_redemptions AS redemptions
      LEFT JOIN channel_points_rewards AS rewards
        ON rewards.channel_id=redemptions.channel_id AND rewards.id=redemptions.reward_id
      WHERE redemptions.channel_id=? AND redemptions.status='queued'
      ORDER BY redemptions.redeemed_at ASC,redemptions.redemption_id ASC
      LIMIT ?`)
      .bind(channelId, limit).all<RedemptionRow & { action_module_id: string | null; action_id: string | null }>();
    return rows.results.map((row) => ({
      redemption: redemptionFromRow(row),
      actionModuleId: row.action_module_id ?? "",
      actionId: row.action_id ?? "",
    }));
  },
  async listRetryable(channelId, expiredBefore) {
    const rows = await db.prepare("SELECT * FROM channel_points_redemptions WHERE channel_id=? AND (status='received' OR (status IN ('pending','running','failed_to_update') AND (claimed_at IS NULL OR claimed_at<=?) AND (status!='failed_to_update' OR pending_twitch_status IS NOT NULL))) ORDER BY redeemed_at")
      .bind(channelId, expiredBefore).all<RedemptionRow>();
    return rows.results.map(redemptionFromRow);
  },
  async listOpenRedemptions(channelId, expiredBefore) {
    const rows = await db.prepare("SELECT * FROM channel_points_redemptions WHERE channel_id=? AND (status IN ('received','queued','pending','failed_to_update') OR (status='running' AND (claimed_at IS NULL OR claimed_at<=?))) ORDER BY redeemed_at")
      .bind(channelId, expiredBefore).all<RedemptionRow>();
    return rows.results.map(redemptionFromRow);
  },
  async persistReconcileTime(channelId, now) {
    await db.prepare("INSERT INTO channel_points_reconcile_state(channel_id,last_reconciled_at) VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET last_reconciled_at=excluded.last_reconciled_at")
      .bind(channelId, now).run();
  },
  async lastReconciledAt(channelId) {
    return (await db.prepare("SELECT last_reconciled_at FROM channel_points_reconcile_state WHERE channel_id=?")
      .bind(channelId).first<{ last_reconciled_at: string }>())?.last_reconciled_at ?? null;
  },
});
