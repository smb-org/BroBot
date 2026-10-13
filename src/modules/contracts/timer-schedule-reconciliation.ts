export interface TimerScheduleReconciliationRow {
  channel_id: string;
  timer_id: string;
  revision: number;
  mutation_id: string;
  reason: "event_times" | "channel_time_zone" | "activation" | "stream_state";
}

export interface TimerScheduleReconciliationTarget {
  timerId: string;
  revision: number;
}

export const timerScheduleReconciliationMutation = (
  db: D1Database,
  channelId: string,
  mutationId: string,
  updatedAt: string,
  onlyWhenPreviousStatementChanged = false,
  reason: TimerScheduleReconciliationRow["reason"] = "activation",
  target?: TimerScheduleReconciliationTarget,
): D1PreparedStatement => {
  const storedReason = reason === "event_times" ? "channel_time_zone" : reason;
  const timerId = target?.timerId ?? "";
  const revision = target?.revision ?? 0;
  return db.prepare(onlyWhenPreviousStatementChanged
    ? `INSERT INTO timer_schedule_reconciliation (channel_id, timer_id, revision, mutation_id, updated_at, reason)
       SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0
       ON CONFLICT(channel_id, timer_id, revision) DO UPDATE SET
         mutation_id = excluded.mutation_id,
         updated_at = excluded.updated_at,
         reason = CASE
           WHEN timer_schedule_reconciliation.reason IN ('event_times', 'channel_time_zone')
             OR excluded.reason IN ('event_times', 'channel_time_zone')
           THEN 'channel_time_zone'
           WHEN timer_schedule_reconciliation.reason = 'activation' OR excluded.reason = 'activation'
           THEN 'activation' ELSE excluded.reason END`
    : `INSERT INTO timer_schedule_reconciliation (channel_id, timer_id, revision, mutation_id, updated_at, reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, timer_id, revision) DO UPDATE SET
         mutation_id = excluded.mutation_id,
         updated_at = excluded.updated_at,
         reason = CASE
           WHEN timer_schedule_reconciliation.reason IN ('event_times', 'channel_time_zone')
             OR excluded.reason IN ('event_times', 'channel_time_zone')
           THEN 'channel_time_zone'
           WHEN timer_schedule_reconciliation.reason = 'activation' OR excluded.reason = 'activation'
           THEN 'activation' ELSE excluded.reason END`)
    .bind(channelId, timerId, revision, mutationId, updatedAt, storedReason);
};

export const clearTimerScheduleReconciliation = async (
  db: D1Database,
  channelId: string,
  timerId: string,
  revision: number,
  mutationId: string,
  expectedReason?: TimerScheduleReconciliationRow["reason"],
): Promise<void> => {
  await db.prepare(
    `DELETE FROM timer_schedule_reconciliation
      WHERE channel_id = ? AND timer_id = ? AND revision = ? AND mutation_id = ? AND (? IS NULL OR reason = ?)`,
  ).bind(channelId, timerId, revision, mutationId, expectedReason ?? null, expectedReason ?? null).run();
};
