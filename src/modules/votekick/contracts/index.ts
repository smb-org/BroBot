import { z } from "zod";

import { timeoutDurationRangeSchema } from "../../contracts/moderation";
import { VOTEKICK_DEFAULT_TEXTS } from "./chat-defaults";
import { templateTextLength } from "../../../contracts/template-text-length";
import { isMessageEnabled } from "../../../contracts/message-enabled";

export const VOTEKICK_MODULE_ID = "votekick";
export const VOTEKICK_WINDOW_MS = 10 * 60 * 1000;
const VOTEKICK_MAX_WINDOW_SECONDS = 180;
const VOTEKICK_MIN_WINDOW_SECONDS = 30;
export const VOTEKICK_HISTORY_DAYS = 14;
export const VOTEKICK_LIFT_CLAIM_LEASE_MS = 5 * 60 * 1_000;

const votekickSettingsObjectSchema = z.object({
  starterMinRole: z.enum(["viewer", "subscriber", "vip", "moderator", "broadcaster"]).default("vip"),
  minNetVotes: z.number().int().min(3).max(100_000),
  percent: z.number().int().min(5).max(100),
  windowSeconds: z.number().int().min(VOTEKICK_MIN_WINDOW_SECONDS).max(VOTEKICK_MAX_WINDOW_SECONDS),
  duration: timeoutDurationRangeSchema(3600),
  channelCooldownSeconds: z.number().int().min(60).max(86_400),
  targetCooldownSeconds: z.number().int().min(60).max(86_400),
  chatTarget: z.enum(["all_chats", "source_only"]),
  startTextEnabled: z.boolean().optional(),
  passTextEnabled: z.boolean().optional(),
  failTextEnabled: z.boolean().optional(),
  expiredTextEnabled: z.boolean().optional(),
  protectedTextEnabled: z.boolean().optional(),
  busyTextEnabled: z.boolean().optional(),
  startText: z.string().refine((text) => templateTextLength(text) <= 500),
  passText: z.string().refine((text) => templateTextLength(text) <= 500),
  failText: z.string().refine((text) => templateTextLength(text) <= 500),
  expiredText: z.string().refine((text) => templateTextLength(text) <= 500),
  protectedText: z.string().refine((text) => templateTextLength(text) <= 500),
  busyText: z.string().refine((text) => templateTextLength(text) <= 500),
});

const validateVotekickMessages = (settings: z.output<typeof votekickSettingsObjectSchema>, context: z.RefinementCtx): void => {
  for (const key of ["startText", "passText", "failText", "expiredText", "protectedText", "busyText"] as const) {
    const enabledKey = `${key}Enabled`;
    if (isMessageEnabled(settings, key, enabledKey) && settings[key].trim().length === 0) {
      context.addIssue({ code: "custom", path: [key], message: "message_text_missing" });
    }
  }
};

export const votekickSettingsReadSchema = votekickSettingsObjectSchema;
export const votekickSettingsSchema = votekickSettingsObjectSchema.superRefine(validateVotekickMessages);

export type VotekickSettings = z.output<typeof votekickSettingsSchema>;
export const DEFAULT_VOTEKICK_SETTINGS: VotekickSettings = {
  starterMinRole: "vip",
  minNetVotes: 5,
  percent: 20,
  windowSeconds: 60,
  duration: { minSeconds: 120, maxSeconds: 120 },
  channelCooldownSeconds: 300,
  targetCooldownSeconds: 1800,
  chatTarget: "source_only",
  startTextEnabled: true,
  passTextEnabled: true,
  failTextEnabled: true,
  expiredTextEnabled: true,
  protectedTextEnabled: true,
  busyTextEnabled: true,
  ...VOTEKICK_DEFAULT_TEXTS.en,
};

export const votekickDefaultSettingsForLanguage = (language: "de" | "en"): VotekickSettings => ({
  ...DEFAULT_VOTEKICK_SETTINGS,
  ...VOTEKICK_DEFAULT_TEXTS[language],
});

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
  liftClaimedAt: string | null;
}
