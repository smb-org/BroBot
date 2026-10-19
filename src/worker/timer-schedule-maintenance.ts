import {
  clearTimerScheduleReconciliation,
  type TimerScheduleReconciliationRow,
} from "../modules/contracts/timer-schedule-reconciliation";

interface TimerScheduleReconciliationStub {
  reconcileTimerSchedules(reason: TimerScheduleReconciliationRow["reason"]): Promise<void>;
}

/** Replays committed timer and stream changes that could not reach their channel DO immediately. */
export const maintainTimerSchedules = async (env: Env): Promise<void> => {
  const rows = await env.DB.prepare(
    `SELECT channel_id, timer_id, revision, mutation_id, reason
       FROM timer_schedule_reconciliation
      ORDER BY updated_at, channel_id, timer_id, revision`,
  ).all<TimerScheduleReconciliationRow>();

  const reconciledChannels = new Set<string>();
  for (const row of rows.results) {
    try {
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(row.channel_id)) as unknown as TimerScheduleReconciliationStub;
      await stub.reconcileTimerSchedules(row.reason);
      reconciledChannels.add(row.channel_id);
      await clearTimerScheduleReconciliation(env.DB, row.channel_id, row.timer_id, row.revision, row.mutation_id);
    } catch (error: unknown) {
      console.warn("Timer schedule reconciliation remains pending.", row.channel_id, error);
    }
  }

  const coldSchedules = await env.DB.prepare(
    `SELECT DISTINCT timer.channel_id
       FROM timers AS timer
       JOIN channel_modules AS module
         ON module.channel_id = timer.channel_id AND module.module_id = 'timers' AND module.enabled = 1
      WHERE timer.enabled = 1 AND timer.schedule_mirror_sequence = 0
      ORDER BY timer.channel_id`,
  ).all<{ channel_id: string }>();
  for (const { channel_id: channelId } of coldSchedules.results) {
    if (reconciledChannels.has(channelId)) continue;
    try {
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(channelId)) as unknown as TimerScheduleReconciliationStub;
      await stub.reconcileTimerSchedules("activation");
    } catch (error: unknown) {
      console.warn("Cold timer schedule bootstrap remains pending.", channelId, error);
    }
  }
};
