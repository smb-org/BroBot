import type { BotModule, ModuleImmediateActionCondition } from "../contract";
import { DEFAULT_TEMP_VIPS_SETTINGS, TEMP_VIPS_MODULE_ID, tempVipsSettingsSchema } from "./contracts";
import { tempVipsRoutes } from "./routes";
import { tempVipsCockpitActionTexts } from "./panel/action-locale";
import { TEMP_VIPS_CHAT_COMMANDS } from "./contracts/chat-commands";
import { processTempVipsChatMessage } from "./service";
import { dryRunTempVipsChatMessage } from "./dry-run";
import { formatTempVipResult } from "./panel/result-message";
import { loadTempVipActionReadiness, type TempVipActionReadiness } from "./panel/service";
import { grantVipAction } from "./actions/grant-vip";

const broadcasterVipPermission: ModuleImmediateActionCondition = {
  query: {
    moduleId: "temp_vips",
    part: "broadcaster-vip-permission",
    load: async (channelId, signal) => {
      try {
        return await loadTempVipActionReadiness(channelId, signal);
      } catch {
        return { ready: false, missingScopes: [], metadataUnknown: true } satisfies TempVipActionReadiness;
      }
    },
    evaluate: (value) => {
      const state = value as TempVipActionReadiness;
      const reason = state.metadataUnknown
        ? tempVipsCockpitActionTexts.de.scopeCheckFailed
        : state.ready ? null : tempVipsCockpitActionTexts.de.scopeMissing;
      const englishReason = state.metadataUnknown
        ? tempVipsCockpitActionTexts.en.scopeCheckFailed
        : state.ready ? null : tempVipsCockpitActionTexts.en.scopeMissing;
      return { reason: reason === null || englishReason === null ? null : { de: reason, en: englishReason } };
    },
  },
};

export const tempVipsModule: BotModule<typeof tempVipsSettingsSchema> = {
  id: TEMP_VIPS_MODULE_ID,
  navigationCategory: "twitch",
  defaultEnabled: false,
  broadcasterScopes: [],
  chatCommands: TEMP_VIPS_CHAT_COMMANDS,
  eventSubTypes: ["channel.vip.remove", "channel.chat.message", "channel.moderate"],
  scopeIndependentEventSubTypes: ["channel.chat.message", "channel.moderate"],
  pauseSafeEventSubTypes: ["channel.vip.remove", "channel.moderate"],
  settingsSchema: tempVipsSettingsSchema,
  defaultSettings: DEFAULT_TEMP_VIPS_SETTINGS,
  channelPointsActions: [grantVipAction],
  handleEvent: processTempVipsChatMessage,
  dryRunChatMessage: dryRunTempVipsChatMessage,
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorRelatedParts: ["vips"],
  panel: () => import("./panel"),
  routes: tempVipsRoutes,
  actions: [{
    id: "grant-vip",
    name: { de: tempVipsCockpitActionTexts.de.name, en: tempVipsCockpitActionTexts.en.name },
    icon: "timer",
    conditions: ["moduleEnabled", broadcasterVipPermission],
    requiredRole: "operator",
    content: { presentation: "dialog", requiresReadiness: true, load: () => import("./panel/cockpit-action-content") },
    errorMessage: {
      de: tempVipsCockpitActionTexts.de.error,
      en: tempVipsCockpitActionTexts.en.error,
    },
    execute: async ({ channelId, formData }) => {
      const login = formData.get("login");
      const durationDays = Number(formData.get("durationDays"));
      if (typeof login !== "string" || login.trim().length === 0 || !Number.isSafeInteger(durationDays) || durationDays < 1) {
        throw new Error("A Twitch login and positive duration are required.");
      }
      const result = await (await import("./panel/service")).grantTempVip(
        channelId,
        login,
        durationDays * 24 * 60 * 60 * 1_000,
      );
      const timeZone = formData.get("timeZone");
      const displayTimeZone = typeof timeZone === "string" && timeZone.length > 0 ? timeZone : "UTC";
      const success = result.status === "granted" || result.status === "extended";
      return {
        tone: result.status === "queued" || result.status === "busy" ? "info" : success ? "success" : "error",
        message: {
          de: formatTempVipResult(result, "de", displayTimeZone),
          en: formatTempVipResult(result, "en", displayTimeZone),
        },
      };
    },
  }],
  panelIcon: { paths: ["M2 7l5 5 5-8 5 8 5-5-2 13H4z", "M5 16h14"] },
};
