import { z } from "zod";

import type { SongRequestRoleThreshold } from "./domain/rules";
import type { ModuleLanguage } from "../contract";

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
  songCommandEnabled: z.boolean().default(true),
  queueCommandEnabled: z.boolean().default(true),
  wrongSongCommandEnabled: z.boolean().default(true),
  emptyText: z.string().max(80).default(""),
  queuedText: z.string().trim().max(500).default("“{song.track}” was queued in Spotify. Position {song.position}."),
  queuedTextEnabled: z.boolean().default(true),
  waitingText: z.string().trim().max(500).default("“{song.track}” is waiting for moderator approval."),
  waitingTextEnabled: z.boolean().default(true),
  requestAlertText: z.string().trim().max(500).default("{user} · {song.type}: {song.track}"),
  requestAlertTextEnabled: z.boolean().default(true),
  skipVote: z.object({
    enabled: z.boolean().default(false),
    threshold: z.number().int().min(1).max(100).default(5),
    cooldownSeconds: z.number().int().min(0).max(3600).default(120),
  }).prefault({}),
  requestAlert: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  spotlight: z.object({ enabled: z.boolean().default(false) }).prefault({}),
  recap: z.object({ chatEnabled: z.boolean().default(true) }).prefault({}),
  rules: songRequestRulesSchema,
});

export type SongRequestsSettings = z.output<typeof songRequestsSettingsSchema>;
export type SongRequestsRoleThreshold = SongRequestRoleThreshold;

export const songRequestsSettingsForLanguage = (language: ModuleLanguage): SongRequestsSettings => songRequestsSettingsSchema.parse({
  queuedText: language === "de"
    ? "„{song.track}“ wurde in Spotify eingereiht. Position {song.position}."
    : "“{song.track}” was queued in Spotify. Position {song.position}.",
  waitingText: language === "de"
    ? "„{song.track}“ wartet auf die Freigabe durch die Moderation."
    : "“{song.track}” is waiting for moderator approval.",
  requestAlertText: "{user} · {song.type}: {song.track}",
});

export interface SongRequestStatistics {
  requesters: readonly { userId: string; displayName: string; count: number }[];
  tracks: readonly { trackId: string; title: string; artists: readonly string[]; albumName?: string | null; count: number }[];
}

export interface SongRequestChapterTrack {
  id: string;
  title: string;
  artists: readonly string[];
  coverUrl: string | null;
}

export interface SongRequestChapter {
  id: string;
  channelId: string;
  name: string;
  tracks: readonly SongRequestChapterTrack[];
  offerInCockpit: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

