import { z } from "zod";

import { DEFAULT_PREWARNING_TEXT } from "./chat-defaults";
import type { TemplateFields, TemplateVariable } from "../contract";
import { adsTemplateVariableCatalog } from "./template-variable-catalog";
import { templateTextLength } from "../../../contracts/template-text-length";
import { isMessageEnabled } from "../../../contracts/message-enabled";

/** Consent for control actions during a live stream; does not block the subscription. */
export const ADS_OPTIONAL_BROADCASTER_SCOPES = ["channel:manage:ads", "channel:edit:commercial"] as const;

const adsSettingsObjectSchema = z.object({
  automatic: z.string().trim().refine((text) => templateTextLength(text) <= 500),
  automaticEnabled: z.boolean().optional(),
  manual: z.string().trim().refine((text) => templateTextLength(text) <= 500),
  manualEnabled: z.boolean().optional(),
  automaticTarget: z.enum(["all_chats", "source_only"]).default("source_only"),
  manualTarget: z.enum(["all_chats", "source_only"]).default("source_only"),
  leadSeconds: z.number().int().min(30).max(300).default(60),
  prewarningText: z.string().trim().refine((text) => templateTextLength(text) <= 500).default(DEFAULT_PREWARNING_TEXT),
  prewarningTextEnabled: z.boolean().optional(),
  prewarningTarget: z.enum(["all_chats", "source_only"]).default("source_only"),
});

const validatedAdsSettingsSchema = adsSettingsObjectSchema.superRefine((settings, context) => {
  for (const [messageKey, enabledKey] of [
    ["automatic", "automaticEnabled"],
    ["manual", "manualEnabled"],
    ["prewarningText", "prewarningTextEnabled"],
  ] as const) {
    if (isMessageEnabled(settings, messageKey, enabledKey) && settings[messageKey].trim().length === 0) {
      context.addIssue({ code: "custom", path: [messageKey], message: "message_text_missing" });
    }
  }
});

const legacyAdsSettingsPreprocess = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Reflect.get(input, "prewarning") !== false) return input;
  return { ...input, prewarningTextEnabled: false };
};

export const adsSettingsReadSchema = z.preprocess(legacyAdsSettingsPreprocess, adsSettingsObjectSchema);
export const adsSettingsSchema = z.preprocess(legacyAdsSettingsPreprocess, validatedAdsSettingsSchema);

export type AdsSettings = Omit<z.output<typeof adsSettingsSchema>, "automaticTarget" | "manualTarget" | "prewarningTarget"> & {
  /** Accepted only while older persisted settings are upgraded. */
  prewarning?: boolean;
  automaticTarget?: "all_chats" | "source_only";
  manualTarget?: "all_chats" | "source_only";
  prewarningTarget?: "all_chats" | "source_only";
};

const ADS_VARIABLES = {
  duration: { name: "ads.duration", group: "event", contexts: ["event"], sample: "90", maxLength: 4, fallbackWhenAbsent: 15, picker: { de: adsTemplateVariableCatalog.de["ads.duration"], en: adsTemplateVariableCatalog.en["ads.duration"] } },
  seconds: { name: "ads.seconds", group: "event", contexts: ["event"], sample: "60", maxLength: 3, picker: { de: adsTemplateVariableCatalog.de["ads.seconds"], en: adsTemplateVariableCatalog.en["ads.seconds"] } },
} as const satisfies Record<string, TemplateVariable>;

export const ADS_TEMPLATE_FIELDS = {
  automatic: [ADS_VARIABLES.duration],
  manual: [ADS_VARIABLES.duration],
  prewarningText: [ADS_VARIABLES.seconds],
} as const satisfies TemplateFields<AdsSettings>;

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
  /** Time the cached Twitch schedule was last fetched successfully. */
  asOf?: string;
}
