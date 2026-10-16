import { z } from "zod";

export const MIN_AUTOMATIC_CLIP_COOLDOWN_SECONDS = 60;

export const clipsSettingsSchema = z.object({
  commandMinimumRole: z.enum(["viewer", "subscriber", "vip", "moderator", "broadcaster"]).default("viewer"),
  commandCooldownSeconds: z.number().int().min(0).max(86400).default(60),
  postClipLinkInChat: z.boolean().default(true),
  chatLinkTemplate: z.string().min(1).max(500).default("Clip aus dem Stream: {clip.title} {clip.url}"),
  automaticClipsEnabled: z.boolean().default(false),
  automaticThresholdMultiplier: z.number().min(1).max(10).default(2.5),
  automaticCooldownSeconds: z.number().int().min(0).max(86400).default(900),
}).refine(
  (settings) => !settings.automaticClipsEnabled || settings.automaticCooldownSeconds >= MIN_AUTOMATIC_CLIP_COOLDOWN_SECONDS,
  { path: ["automaticCooldownSeconds"], message: "Automatic clips require a cooldown of at least 60 seconds." },
);

export type ClipsSettings = z.output<typeof clipsSettingsSchema>;

interface SessionClip {
  clipId: string;
  createdAt: string;
}

export interface SessionClipList {
  streamStartedAt: string | null;
  clips: SessionClip[];
}
