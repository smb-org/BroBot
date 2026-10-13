import type { Timer, TimerIntervalState } from "./contracts";

export const persistIntervalTimerPlan = async (
  db: D1Database,
  channelId: string,
  timer: Timer,
  nextAt: number | null,
  streamId: string | null,
  state: TimerIntervalState | null,
  activityCount: number | null,
  streamGeneration: number,
  expectedPlan: Timer,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE timers
        SET next_run_at = ?, next_run_stream_id = ?, next_run_state = ?, next_run_generation = ?,
            next_run_plan_sequence = next_run_plan_sequence + 1,
            last_chat_activity_count = ?, chat_baseline_stream_id = ?
      WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = ?
        AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?
        AND trigger_type IS ? AND next_run_at IS ? AND next_run_stream_id IS ? AND
            next_run_state IS ? AND next_run_generation IS ? AND next_run_plan_sequence = ?`,
  ).bind(
    nextAt === null ? null : new Date(nextAt).toISOString(),
    nextAt === null ? null : streamId,
    nextAt === null ? null : state,
    nextAt === null ? null : streamGeneration,
    activityCount,
    nextAt !== null && state === "live" ? streamId : null,
    channelId,
    timer.id,
    timer.revision,
    timer.enabled ? 1 : 0,
    streamGeneration,
    expectedPlan.trigger.type,
    expectedPlan.nextRunAt,
    expectedPlan.nextRunStreamId,
    expectedPlan.nextRunState,
    expectedPlan.nextRunGeneration,
    expectedPlan.nextRunPlanSequence,
  ).run();
  return result.meta.changes > 0;
};
