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

  for (const row of rows.results) {
    try {
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(row.channel_id)) as unknown as TimerScheduleReconciliationStub;
      await stub.reconcileTimerSchedules(row.reason);
      await clearTimerScheduleReconciliation(env.DB, row.channel_id, row.timer_id, row.revision, row.mutation_id);
    } catch (error: unknown) {
      console.warn("Timer schedule reconciliation remains pending.", row.channel_id, error);
    }
  }
};
