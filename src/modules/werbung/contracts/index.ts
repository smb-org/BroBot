import { z } from "zod";

export const werbungSettingsSchema = z.object({
  automatisch: z.string().trim().min(1).max(200),
  manuell: z.string().trim().min(1).max(200),
});

export type WerbungSettings = z.output<typeof werbungSettingsSchema>;

export interface WerbepausenEreignis {
  dauerSekunden: number;
  gestartetAm: string;
  endetAm: string;
  automatisch: boolean;
  ausloeserLogin: string | null;
}
