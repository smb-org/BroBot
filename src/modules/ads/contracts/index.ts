import { z } from "zod";

/** Consent for control actions during a live stream; does not block the subscription. */
export const ADS_OPTIONAL_BROADCASTER_SCOPES = ["channel:manage:ads"] as const;

export const adsSettingsSchema = z.object({
  automatic: z.string().trim().min(1).max(200),
  manual: z.string().trim().min(1).max(200),
  prewarning: z.boolean().default(true),
  leadSeconds: z.number().int().min(30).max(300).default(60),
  prewarningText: z.string().trim().min(1).max(200).default("Werbung in {seconds} Sekunden. Bin gleich zurück!"),
});

export type AdsSettings = z.output<typeof adsSettingsSchema>;

export interface AdBreaksEvent {
  durationSeconds: number;
  startedAt: string;
  endsAt: string;
  automatic: boolean;
  triggerLogin: string | null;
}

export interface AdsSchedule {
  nextAdAt: string | null;
  duration: number | null;
  lastAdAt: string | null;
  prerollFreeTime: number | null;
  snoozeCount: number | null;
  snoozeRefreshAt: string | null;
}

export interface LastAdBreak {
  timestamp: string;
  durationSeconds: number;
}

export interface AdsScheduleResponse {
  schedule: AdsSchedule;
  recentAdBreaks: LastAdBreak[];
  snoozeScopeAvailable: boolean;
}
