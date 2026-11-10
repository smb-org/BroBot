import type {
  ChannelPointsRedemption, ChannelPointsRedemptionStatus, ChannelPointsReward, ChannelPointsRewardInput,
  TwitchRedemptionStatus,
} from "./contracts";

interface RewardRow {
  id: string; twitch_reward_id: string; title: string; prompt: string | null; cost: number;
  background_color: string | null; is_user_input_required: number; global_cooldown_seconds: number | null;
  max_per_stream: number | null; max_per_user_per_stream: number | null; action_module_id: string;
  action_id: string; action_config_json: string; mode: "auto" | "queue"; enabled: number;
  twitch_state: "active" | "deleted_on_twitch"; created_at: string; updated_at: string;
}
interface RedemptionRow {
  redemption_id: string; reward_id: string; reward_title: string; user_id: string; user_login: string;
  user_name: string; user_input: string; redeemed_at: string; status: ChannelPointsRedemptionStatus;
  pending_twitch_status: TwitchRedemptionStatus | null; outcome_reason_json: string | null;
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
  redemptionId: row.redemption_id, rewardId: row.reward_id, rewardTitle: row.reward_title,
  userId: row.user_id, userLogin: row.user_login, userName: row.user_name, userInput: row.user_input,
  redeemedAt: row.redeemed_at, status: row.status, pendingTwitchStatus: row.pending_twitch_status,
  outcomeReason: row.outcome_reason_json === null ? null : JSON.parse(row.outcome_reason_json) as { de: string; en: string },
  createdAt: row.created_at, updatedAt: row.updated_at,
});
export interface ChannelPointsRepository {
  listRewards(channelId: string): Promise<ChannelPointsReward[]>;
  getReward(channelId: string, id: string): Promise<ChannelPointsReward | null>;
  getRewardByTwitchId(channelId: string, id: string): Promise<ChannelPointsReward | null>;
  insertReward(channelId: string, reward: ChannelPointsRewardInput, id: string, twitchRewardId: string, now: string): Promise<void>;
  updateReward(channelId: string, id: string, reward: ChannelPointsRewardInput, now: string): Promise<void>;
  adoptTwitchReward(channelId: string, reward: { id: string; title: string; prompt: string | null; cost: number; backgroundColor: string | null; isUserInputRequired: boolean; globalCooldownSeconds: number | null; maxPerStream: number | null; maxPerUserPerStream: number | null; isEnabled: boolean }, now: string): Promise<void>;
  markRewardDeleted(channelId: string, twitchRewardId: string, now: string): Promise<void>;
  deleteReward(channelId: string, id: string): Promise<void>;
  replaceTwitchId(channelId: string, id: string, twitchRewardId: string, now: string): Promise<void>;
  latchRedemption(channelId: string, redemption: { id: string; rewardId: string; rewardTitle: string; userId: string; userLogin: string; userName: string; userInput: string; redeemedAt: string }, now: string): Promise<boolean>;
  getRedemption(channelId: string, id: string): Promise<ChannelPointsRedemption | null>;
  updateRedemption(channelId: string, id: string, change: { status: ChannelPointsRedemptionStatus; pendingTwitchStatus?: TwitchRedemptionStatus | null; outcomeReason?: { de: string; en: string } | null }, now: string): Promise<void>;
  listRedemptions(channelId: string, cursor: string | null, limit: number): Promise<{ items: ChannelPointsRedemption[]; cursor: string | null }>;
  listRetryable(channelId: string): Promise<ChannelPointsRedemption[]>;
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
  async insertReward(channelId, reward, id, twitchRewardId, now) {
    await db.prepare("INSERT INTO channel_points_rewards (channel_id,id,twitch_reward_id,title,prompt,cost,background_color,is_user_input_required,global_cooldown_seconds,max_per_stream,max_per_user_per_stream,action_module_id,action_id,action_config_json,mode,enabled,twitch_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)")
      .bind(channelId, id, twitchRewardId, reward.title, reward.prompt, reward.cost, reward.backgroundColor,
        Number(reward.isUserInputRequired), reward.globalCooldownSeconds, reward.maxPerStream, reward.maxPerUserPerStream,
        reward.actionModuleId, reward.actionId, JSON.stringify(reward.actionConfig), reward.mode, Number(reward.enabled), now, now).run();
  },
  async updateReward(channelId, id, reward, now) {
    await db.prepare("UPDATE channel_points_rewards SET title=?,prompt=?,cost=?,background_color=?,is_user_input_required=?,global_cooldown_seconds=?,max_per_stream=?,max_per_user_per_stream=?,action_module_id=?,action_id=?,action_config_json=?,mode=?,enabled=?,updated_at=? WHERE channel_id=? AND id=?")
      .bind(reward.title, reward.prompt, reward.cost, reward.backgroundColor, Number(reward.isUserInputRequired),
        reward.globalCooldownSeconds, reward.maxPerStream, reward.maxPerUserPerStream, reward.actionModuleId,
        reward.actionId, JSON.stringify(reward.actionConfig), reward.mode, Number(reward.enabled), now, channelId, id).run();
  },
  async adoptTwitchReward(channelId, reward, now) {
    await db.prepare("UPDATE channel_points_rewards SET title=?,prompt=?,cost=?,background_color=?,is_user_input_required=?,global_cooldown_seconds=?,max_per_stream=?,max_per_user_per_stream=?,enabled=?,twitch_state='active',updated_at=? WHERE channel_id=? AND twitch_reward_id=?")
      .bind(reward.title, reward.prompt, reward.cost, reward.backgroundColor, Number(reward.isUserInputRequired),
        reward.globalCooldownSeconds, reward.maxPerStream, reward.maxPerUserPerStream, Number(reward.isEnabled), now, channelId, reward.id).run();
  },
  async markRewardDeleted(channelId, twitchRewardId, now) {
    await db.prepare("UPDATE channel_points_rewards SET twitch_state='deleted_on_twitch',updated_at=? WHERE channel_id=? AND twitch_reward_id=?")
      .bind(now, channelId, twitchRewardId).run();
  },
  async deleteReward(channelId, id) {
    await db.prepare("DELETE FROM channel_points_rewards WHERE channel_id=? AND id=?").bind(channelId, id).run();
  },
  async replaceTwitchId(channelId, id, twitchRewardId, now) {
    await db.prepare("UPDATE channel_points_rewards SET twitch_reward_id=?,twitch_state='active',updated_at=? WHERE channel_id=? AND id=?")
      .bind(twitchRewardId, now, channelId, id).run();
  },
  async latchRedemption(channelId, redemption, now) {
    const result = await db.prepare("INSERT OR IGNORE INTO channel_points_redemptions (channel_id,redemption_id,reward_id,reward_title,user_id,user_login,user_name,user_input,redeemed_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'received',?,?)")
      .bind(channelId, redemption.id, redemption.rewardId, redemption.rewardTitle, redemption.userId, redemption.userLogin,
        redemption.userName, redemption.userInput, redemption.redeemedAt, now, now).run();
    return result.meta.changes > 0;
  },
  async getRedemption(channelId, id) {
    const row = await db.prepare("SELECT * FROM channel_points_redemptions WHERE channel_id=? AND redemption_id=?").bind(channelId, id).first<RedemptionRow>();
    return row === null ? null : redemptionFromRow(row);
  },
  async updateRedemption(channelId, id, change, now) {
    await db.prepare("UPDATE channel_points_redemptions SET status=?,pending_twitch_status=?,outcome_reason_json=?,updated_at=? WHERE channel_id=? AND redemption_id=?")
      .bind(change.status, change.pendingTwitchStatus ?? null,
        change.outcomeReason === undefined || change.outcomeReason === null ? null : JSON.stringify(change.outcomeReason),
        now, channelId, id).run();
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
  async listRetryable(channelId) {
    const rows = await db.prepare("SELECT * FROM channel_points_redemptions WHERE channel_id=? AND status IN ('pending','failed_to_update') ORDER BY redeemed_at")
      .bind(channelId).all<RedemptionRow>();
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
