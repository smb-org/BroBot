import type { TimerIntervalState } from "./contracts";

export const persistIntervalTimerPlan = async (
  db: D1Database,
  channelId: string,
  timer: { id: string; revision: number; enabled: boolean },
  nextAt: number | null,
  streamId: string | null,
  state: TimerIntervalState | null,
  activityCount: number | null,
  streamGeneration: number,
  expectedPlan?: { nextRunAt: string | null; nextRunStreamId: string | null; nextRunState: TimerIntervalState | null },
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE timers
        SET next_run_at = ?, next_run_stream_id = ?, next_run_state = ?,
            last_chat_activity_count = ?, chat_baseline_stream_id = ?
      WHERE channel_id = ? AND timer_id = ? AND revision = ? AND enabled = ?
        AND COALESCE((SELECT transition_generation FROM channel_stream_state WHERE channel_id = timers.channel_id), 0) = ?
        AND (? = 0 OR (next_run_at IS ? AND next_run_stream_id IS ? AND next_run_state IS ?))`,
  ).bind(
    nextAt === null ? null : new Date(nextAt).toISOString(),
    nextAt === null ? null : streamId,
    nextAt === null ? null : state,
    activityCount,
    nextAt !== null && state === "live" ? streamId : null,
    channelId,
    timer.id,
    timer.revision,
    timer.enabled ? 1 : 0,
    streamGeneration,
    expectedPlan === undefined ? 0 : 1,
    expectedPlan?.nextRunAt ?? null,
    expectedPlan?.nextRunStreamId ?? null,
    expectedPlan?.nextRunState ?? null,
  ).run();
  return result.meta.changes > 0;
};
