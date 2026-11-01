import type { BotModule } from "../contract";
import { DEFAULT_TEMP_VIPS_SETTINGS, TEMP_VIPS_MODULE_ID, tempVipsSettingsSchema } from "./contracts";
import { tempVipsRoutes } from "./routes";
import { tempVipsCockpitActionTexts } from "./panel/action-locale";

export const tempVipsModule: BotModule<typeof tempVipsSettingsSchema> = {
  id: TEMP_VIPS_MODULE_ID,
  navigationCategory: "twitch",
  defaultEnabled: false,
  broadcasterScopes: ["channel:manage:vips"],
  eventSubTypes: ["channel.vip.remove"],
  pauseSafeEventSubTypes: ["channel.vip.remove"],
  settingsSchema: tempVipsSettingsSchema,
  defaultSettings: DEFAULT_TEMP_VIPS_SETTINGS,
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorRelatedParts: ["vips"],
  panel: () => import("./panel"),
  routes: tempVipsRoutes,
  actions: [{
    id: "grant-vip",
    name: { de: tempVipsCockpitActionTexts.de.name, en: tempVipsCockpitActionTexts.en.name },
    icon: "timer",
    conditions: ["moduleEnabled"],
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
      if (result.status === "queued") {
        return { tone: "info", message: { de: tempVipsCockpitActionTexts.de.pending, en: tempVipsCockpitActionTexts.en.pending } };
      }
      if (result.status !== "granted") throw new Error(result.status);
      return { tone: "success", message: { de: tempVipsCockpitActionTexts.de.success, en: tempVipsCockpitActionTexts.en.success } };
    },
  }],
  panelIcon: { paths: ["M12 6v6l4 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"] },
};
