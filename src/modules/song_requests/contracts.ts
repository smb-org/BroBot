import { z } from "zod";

import type { SongRequestRoleThreshold } from "./domain/rules";

const boundedTextList = (maximum: number, itemMaximum: number) => z.array(z.string().trim().min(1).max(itemMaximum)).max(maximum);

const songRequestRulesSchema = z.object({
  duplicateEnabled: z.boolean().default(true),
  songCooldownEnabled: z.boolean().default(true),
  songCooldownMinutes: z.number().int().min(1).max(10_080).default(60),
  songCooldownOncePerRound: z.boolean().default(false),
  personCooldownEnabled: z.boolean().default(true),
  personCooldownMinutes: z.number().int().min(0).max(10_080).default(5),
  personOpenLimitEnabled: z.boolean().default(true),
  personOpenLimit: z.number().int().min(1).max(50).default(2),
  personRoundLimitEnabled: z.boolean().default(true),
  personRoundLimit: z.number().int().min(1).max(100).default(5),
  channelOpenLimitEnabled: z.boolean().default(true),
  channelOpenLimit: z.number().int().min(1).max(200).default(10),
  artistOpenLimitEnabled: z.boolean().default(true),
  artistOpenLimit: z.number().int().min(1).max(50).default(2),
  maxTrackLengthEnabled: z.boolean().default(true),
  maxTrackLengthMinutes: z.number().int().min(1).max(1_000).default(15),
  blockTracksEnabled: z.boolean().default(false),
  blockedTrackIds: boundedTextList(200, 64).default([]),
  blockArtistsEnabled: z.boolean().default(false),
  blockedArtists: boundedTextList(100, 100).default([]),
  explicitAllowed: z.boolean().default(true),
}).prefault({});

export const songRequestsSettingsSchema = z.object({
  mode: z.enum(["automatic", "moderated"]).default("automatic"),
  paymentMode: z.enum(["bot_points", "free"]).default("bot_points"),
  botPointsCost: z.number().int().min(1).max(1_000_000).default(10),
  freeRoleThreshold: z.enum(["everyone", "subscriber", "vip", "moderator"]).default("everyone"),
  alsoOffline: z.boolean().default(false),
  queueOverlayRows: z.number().int().min(2).max(20).default(10),
  emptyText: z.string().max(80).default(""),
  rules: songRequestRulesSchema,
});

export type SongRequestsSettings = z.output<typeof songRequestsSettingsSchema>;
export type SongRequestsRoleThreshold = SongRequestRoleThreshold;
