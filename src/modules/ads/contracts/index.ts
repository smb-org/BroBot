import { z } from "zod";

/** Zustimmung für Bedienhandlungen im laufenden Stream; blockiert kein Abo. */
export const WERBUNG_OPTIONALE_BROADCASTER_SCOPES = ["channel:manage:ads"] as const;

export const werbungSettingsSchema = z.object({
  automatic: z.string().trim().min(1).max(200),
  manual: z.string().trim().min(1).max(200),
  prewarning: z.boolean().default(true),
  leadSeconds: z.number().int().min(30).max(300).default(60),
  prewarningText: z.string().trim().min(1).max(200).default("Werbung in {seconds} Sekunden. Bin gleich zurück!"),
});

export type WerbungSettings = z.output<typeof werbungSettingsSchema>;

export interface WerbepausenEreignis {
  dauerSekunden: number;
  gestartetAm: string;
  endetAm: string;
  automatic: boolean;
  ausloeserLogin: string | null;
}

export interface WerbungZeitplan {
  nextAdAt: string | null;
  duration: number | null;
  lastAdAt: string | null;
  prerollFreeTime: number | null;
  snoozeCount: number | null;
  snoozeRefreshAt: string | null;
}

export interface LetzteWerbepause {
  zeitpunkt: string;
  dauerSekunden: number;
}

export interface WerbungZeitplanAntwort {
  schedule: WerbungZeitplan;
  letzteWerbepausen: LetzteWerbepause[];
  snoozeScopeVorhanden: boolean;
}
