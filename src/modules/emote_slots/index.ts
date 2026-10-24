import type { BotModule } from "../contract";
import { DEFAULT_EMOTE_SLOT_SETTINGS, EMOTE_SLOTS_MODULE_ID, emoteSlotDefaultSettingsForLanguage, emoteSlotSettingsReadSchema, emoteSlotSettingsSchema } from "./contracts";
import { emoteSlotsCatalog } from "./locale";
import { emoteSlotsRoutes } from "./routes";
import { processEmoteSlotMessage } from "./service";
import { calculateSlotPayoutRateForDraft } from "./domain/payout-rate";
import { emoteSlotOverlayElements } from "./overlay/element";

export const emoteSlotsModule: BotModule<typeof emoteSlotSettingsSchema> = {
  id: EMOTE_SLOTS_MODULE_ID,
  navigationCategory: "games",
  requiresModules: ["points"],
  navigationEntries: [{
    id: "slot",
    label: { de: emoteSlotsCatalog.de.name, en: emoteSlotsCatalog.en.name },
    description: { de: emoteSlotsCatalog.de.description, en: emoteSlotsCatalog.en.description },
    iconKind: "slot",
    keywords: ["slot", "jackpot", "emote"],
  }],
  panelIcon: { paths: ["M3 5h18v14H3z", "M7 9h2", "M11 9h2", "M15 9h2", "M7 14h2", "M11 14h2", "M15 14h2"] },
  chatCommands: [{
    name: "!slot",
    syntax: "!slot [stake]",
    description: { de: emoteSlotsCatalog.de.commands.slot, en: emoteSlotsCatalog.en.commands.slot },
    minimumChatStatus: "everyone",
    arguments: [{ name: "stake", hint: { de: emoteSlotsCatalog.de.commands.stakeHint, en: emoteSlotsCatalog.en.commands.stakeHint } }],
  }],
  settingsSchema: emoteSlotSettingsSchema,
  settingsReadSchema: emoteSlotSettingsReadSchema,
  defaultSettings: DEFAULT_EMOTE_SLOT_SETTINGS,
  defaultSettingsForLanguage: emoteSlotDefaultSettingsForLanguage,
  validateSettings: (settings) => {
    const rate = calculateSlotPayoutRateForDraft(settings);
    return rate === null ? "invalid_settings" : rate.allowed ? null : "payout_rate_too_high";
  },
  routes: emoteSlotsRoutes,
  defaultEnabled: false,
  settingsEditorPlacement: "page",
  overlayElements: emoteSlotOverlayElements,
  settingsEditor: () => import("./panel/settings-editor"),
  eventSubTypes: ["channel.chat.message"],
  dryRunSilentReason: "instant_settlement",
  handleEvent: processEmoteSlotMessage,
};
