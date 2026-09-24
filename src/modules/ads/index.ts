import type { BotModule } from "../contract";
import { ADS_TEMPLATE_FIELDS, adsSettingsSchema } from "./contracts";
import { DEFAULT_AUTOMATIC_TEXT, DEFAULT_MANUAL_TEXT, DEFAULT_PREWARNING_TEXT } from "./contracts/chat-defaults";
import { processAdBreak } from "./service";
import { adsRoutes } from "./routes";
import { settingsVariableReferences } from "../contract";

export { decideAdBreak, decideAdPrewarning, renderAdBreakText, renderPrewarningText } from "./domain";
export { processAdBreak } from "./service";
export type { AdsSettings, AdBreaksEvent } from "./contracts";
export type { LastAdBreak, AdsSchedule, AdsScheduleResponse } from "./contracts";
export { ADS_OPTIONAL_BROADCASTER_SCOPES, ADS_TEMPLATE_FIELDS, ADS_VARIABLES } from "./contracts";

export const adsModule: BotModule<typeof adsSettingsSchema> = {
  id: "ads",
  settingsSchema: adsSettingsSchema,
  templateFields: ADS_TEMPLATE_FIELDS,
  templateContext: "system",
  variableReferences: settingsVariableReferences("ads", ["automatic", "manual", "prewarningText"]),
  defaultSettings: {
    automatic: DEFAULT_AUTOMATIC_TEXT,
    manual: DEFAULT_MANUAL_TEXT,
    prewarning: true,
    leadSeconds: 60,
    prewarningText: DEFAULT_PREWARNING_TEXT,
  },
  broadcasterScopes: ["channel:read:ads"],
  eventSubTypes: ["stream.online", "channel.ad_break.begin"],
  routes: adsRoutes,
  panel: () => import("./panel"),
  settingsEditor: () => import("./panel/settings-editor"),
  immediateActions: {
    requires: ["streamLive"],
    load: () => import("./panel/immediate-actions"),
  },
  handleEvent: async (event, context) => event.subscriptionType === "channel.ad_break.begin"
    ? processAdBreak(event, context.renderTemplate, await context.channelLanguage())
    : { actions: [], diagnostics: [] },
};
