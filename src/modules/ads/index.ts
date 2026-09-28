import type { BotModule, ModuleTemplateUsageSource } from "../contract";
import { ADS_TEMPLATE_FIELDS, adsSettingsSchema } from "./contracts";
import { DEFAULT_AUTOMATIC_TEXT, DEFAULT_MANUAL_TEXT, DEFAULT_PREWARNING_TEXT } from "./contracts/chat-defaults";
import { processAdBreak } from "./service";
import { adsRoutes } from "./routes";
import { settingsVariableReferences } from "../contract";
import { readAdCountdownState } from "./adapters/countdown-state";
import { readAdCountdownSnapshot } from "./adapters/countdown-state";
import { adsOverlayElements } from "./overlay/element";
import { adsTemplateVariableGroupLabels } from "./contracts/template-variable-catalog";
import { adsEventTimeLabel } from "./contracts/language";

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

export { decideAdBreak, decideAdPrewarning, renderAdBreakText, renderPrewarningText } from "./domain";
export { processAdBreak } from "./service";
export type { AdsSettings, AdBreaksEvent } from "./contracts";
export type { LastAdBreak, AdsSchedule, AdsScheduleResponse } from "./contracts";
export { ADS_OPTIONAL_BROADCASTER_SCOPES, ADS_TEMPLATE_FIELDS, ADS_VARIABLES } from "./contracts";
export { createAdCountdownOverlayAction } from "./overlay/countdown-action";
export { ADS_COUNTDOWN_ELEMENT_KIND } from "./overlay/kinds";

export const adsModule: BotModule<typeof adsSettingsSchema> = {
  id: "ads",
  panelIcon: adsPanelIcon,
  templateVariableGroup: { label: adsTemplateVariableGroupLabels, icon: adsPanelIcon, order: 70 },
  settingsSchema: adsSettingsSchema,
  templateFields: ADS_TEMPLATE_FIELDS,
  templateContext: "system",
  templateUsageSources,
  variableReferences: settingsVariableReferences("ads", ["automatic", "manual", "prewarningText"]),
  defaultSettings: {
    automatic: DEFAULT_AUTOMATIC_TEXT,
    manual: DEFAULT_MANUAL_TEXT,
    automaticTarget: "source_only",
    manualTarget: "source_only",
    prewarning: true,
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
  settingsEditor: () => import("./panel/settings-editor"),
  overlayElements: adsOverlayElements.map((element) => element.kind === "ads.countdown"
    ? {
      ...element,
      initialState: async (db, channelId) => ({ ...await readAdCountdownState(db, channelId) }),
    }
    : element),
  immediateActions: {
    requires: ["streamLive"],
    load: () => import("./panel/immediate-actions"),
  },
  handleEvent: async (event, context) => event.subscriptionType === "channel.ad_break.begin"
    ? processAdBreak(event, context.renderTemplate, await context.channelLanguage())
    : { actions: [], diagnostics: [] },
};
