import type { BotModule, ModuleTemplateUsageSource } from "../contract";
import { ADS_TEMPLATE_FIELDS, adsSettingsReadSchema, adsSettingsSchema } from "./contracts";
import { DEFAULT_AUTOMATIC_TEXT, DEFAULT_MANUAL_TEXT, DEFAULT_PREWARNING_TEXT } from "./contracts/chat-defaults";
import { processAdBreak } from "./service";
import { adsRoutes } from "./routes";
import { settingsVariableReferences } from "../contract";
import { readAdCountdownState } from "./adapters/countdown-state";
import { readAdCountdownSnapshot } from "./adapters/countdown-state";
import { adsOverlayElements } from "./overlay/element";
import { adsTemplateVariableGroupLabels } from "./contracts/template-variable-catalog";
import { adsEventTimeLabel } from "./contracts/language";
import { adsImmediateActionTexts } from "./action-locale";

const adsPanelIcon = { paths: ["M6 8h12v8H6z", "M9 8V6h6v2", "M9 12h6", "M9 16v2h6v-2"] } as const;

const templateUsageSources = async (db: D1Database, channelId: string): Promise<readonly ModuleTemplateUsageSource[]> => {
  const row = await db.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?")
    .bind(channelId, "ads").first<{ settings: string }>();
  if (row === null) return [];
  let settings: unknown;
  try { settings = JSON.parse(row.settings) as unknown; } catch { return []; }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return [];
  return (["automatic", "manual", "prewarningText"] as const).flatMap((field) => {
    const text: unknown = Reflect.get(settings, field);
    return typeof text === "string" ? [{ text, kind: "event" as const, label: `ads.${field}` }] : [];
  });
};

export { processAdBreak } from "./service";

export const adsModule: BotModule<typeof adsSettingsSchema> = {
  id: "ads",
  navigationCategory: "twitch",
  panelIcon: adsPanelIcon,
  templateVariableGroup: { label: adsTemplateVariableGroupLabels, icon: adsPanelIcon, order: 70 },
  settingsSchema: adsSettingsSchema,
  settingsReadSchema: adsSettingsReadSchema,
  templateFields: ADS_TEMPLATE_FIELDS,
  templateContext: "system",
  templateUsageSources,
  variableReferences: settingsVariableReferences("ads", ["automatic", "manual", "prewarningText"]),
  defaultSettings: {
    automatic: DEFAULT_AUTOMATIC_TEXT,
    manual: DEFAULT_MANUAL_TEXT,
    automaticTarget: "source_only",
    manualTarget: "source_only",
    leadSeconds: 60,
    prewarningText: DEFAULT_PREWARNING_TEXT,
    prewarningTarget: "source_only",
  },
  broadcasterScopes: ["channel:read:ads"],
  eventTimeSources: [{
    id: "next_ad_break",
    label: adsEventTimeLabel,
    resolve: async ({ DB, channelId, now }) => {
      const snapshot = await readAdCountdownSnapshot(DB, channelId);
      const at = snapshot?.nextAdAt;
      return at !== null && at !== undefined && Date.parse(at) > now ? [at] : [];
    },
  }],
  eventSubTypes: ["stream.online", "channel.ad_break.begin"],
  routes: adsRoutes,
  panel: () => import("./panel"),
  liveTile: {
    load: async (channelId, signal) => {
      const schedule = await (await import("./panel/service")).loadAdsSchedule(channelId, signal);
      const now = Date.now();
      // The existing channel.ad_break.begin handler stores its actual start and duration in recentAdBreaks.
      const runningBreakEndsAt = schedule.recentAdBreaks.flatMap((breakItem) => {
        const startedAt = Date.parse(breakItem.timestamp);
        const endsAt = startedAt + breakItem.durationSeconds * 1_000;
        return Number.isFinite(startedAt) && startedAt <= now && endsAt > now
          ? [new Date(endsAt).toISOString()]
          : [];
      }).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
      return [{
        kind: "ad_schedule",
        nextAdAt: schedule.schedule.nextAdAt,
        duration: schedule.schedule.duration,
        snoozeCount: schedule.schedule.snoozeCount,
        snoozeScopeAvailable: schedule.snoozeScopeAvailable,
        runningBreakEndsAt,
      }];
    },
  },
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorRelatedParts: ["schedule"],
  overlayElements: adsOverlayElements.map((element) => element.kind === "ads.countdown"
    ? {
      ...element,
      initialState: async (db, channelId) => ({ ...await readAdCountdownState(db, channelId) }),
    }
    : element),
  actions: [{
    id: "start-commercial",
    name: adsImmediateActionTexts.name,
    icon: "ad",
    conditions: ["streamLive"],
    requiredRole: "manager",
    content: { presentation: "popover", load: () => import("./panel/action-content") },
    errorMessage: adsImmediateActionTexts.error,
    execute: async ({ channelId, formData }) => {
      const seconds = Number(formData.get("length"));
      if (!Number.isFinite(seconds)) throw new Error("Invalid ad break length.");
      await (await import("./panel/service")).startCommercialNow(channelId, seconds);
    },
  }],
  handleEvent: async (event, context) => event.subscriptionType === "channel.ad_break.begin"
    ? processAdBreak(event, context.renderTemplate, await context.channelLanguage())
    : { actions: [], diagnostics: [] },
};
