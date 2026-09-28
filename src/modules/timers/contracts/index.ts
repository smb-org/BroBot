import { z } from "zod";

export const TIMER_NAME_MAX_LENGTH = 60;
export const TIMER_MAXIMUM_COUNT = 50;
export const TIMER_MINUTES_MAXIMUM = 24 * 60;
export const TIMER_BLOCK_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

const minutes = z.number().int().min(1).max(TIMER_MINUTES_MAXIMUM);

export const timerTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interval"), minutes, minimumMessages: z.number().int().min(1).max(100_000).optional() }),
  z.object({ type: z.literal("stream_start"), minutes }),
  z.object({
    type: z.literal("time_of_day"),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    alsoOffline: z.boolean().default(false),
  }),
  z.object({ type: z.literal("before_event"), sourceId: z.string().min(1).max(100), minutes }),
]);

export type TimerTrigger = z.output<typeof timerTriggerSchema>;

export interface Timer {
  id: string;
  name: string;
  enabled: boolean;
  blockName: string;
  trigger: TimerTrigger;
  revision: number;
  nextRunAt: string | null;
  /** Twitch stream id `nextRunAt` was armed for, when the trigger is stream-scoped (interval, stream_start). */
  nextRunStreamId: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimerMutationInput {
  name: string;
  blockName: string;
  trigger: TimerTrigger;
}
