import { z } from "zod";

import { timeoutDurationRangeSchema, type TimeoutDurationRange } from "../../contracts/moderation";

export const VOTEKICK_MODULE_ID = "votekick";
export const VOTEKICK_WINDOW_MS = 10 * 60 * 1000;
export const VOTEKICK_MAX_WINDOW_SECONDS = 180;
export const VOTEKICK_MIN_WINDOW_SECONDS = 30;
export const VOTEKICK_HISTORY_DAYS = 14;

export const votekickSettingsSchema = z.object({
  minNetVotes: z.number().int().min(3).max(100_000),
  percent: z.number().int().min(5).max(100),
  windowSeconds: z.number().int().min(VOTEKICK_MIN_WINDOW_SECONDS).max(VOTEKICK_MAX_WINDOW_SECONDS),
  duration: timeoutDurationRangeSchema(3600),
  channelCooldownSeconds: z.number().int().min(60).max(86_400),
  targetCooldownSeconds: z.number().int().min(60).max(86_400),
  chatTarget: z.enum(["all_chats", "source_only"]),
  startText: z.string().max(500),
  passText: z.string().max(500),
  failText: z.string().max(500),
  expiredText: z.string().max(500),
  protectedText: z.string().max(500),
  busyText: z.string().max(500),
});

export type VotekickSettings = z.output<typeof votekickSettingsSchema>;
export type VotekickDuration = TimeoutDurationRange;

export type VotekickStatus = "running" | "passed" | "expired" | "cancelled" | "failed";

export interface Votekick {
  id: string;
  targetUserId: string | null;
  targetLogin: string | null;
  initiatorUserId: string | null;
  status: VotekickStatus;
  threshold: number;
  yesVotes: number;
  noVotes: number;
  ballotRevision: number;
  durationSeconds: number | null;
  startedAt: string;
  endsAt: string;
  endedAt: string | null;
  liftedAt: string | null;
}
