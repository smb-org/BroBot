import { z } from "zod";

/** Zustimmung für Bedienhandlungen im laufenden Stream; blockiert kein Abo. */
export const WERBUNG_OPTIONALE_BROADCASTER_SCOPES = ["channel:manage:ads"] as const;

export const werbungSettingsSchema = z.object({
  automatisch: z.string().trim().min(1).max(200),
  manuell: z.string().trim().min(1).max(200),
  vorwarnung: z.boolean().default(true),
  vorlaufSekunden: z.number().int().min(30).max(300).default(60),
  vorwarnungText: z.string().trim().min(1).max(200).default("Werbung in {seconds} Sekunden. Bin gleich zurück!"),
});

export type WerbungSettings = z.output<typeof werbungSettingsSchema>;

export interface WerbepausenEreignis {
  dauerSekunden: number;
  gestartetAm: string;
  endetAm: string;
  automatisch: boolean;
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
