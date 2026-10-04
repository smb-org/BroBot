import type { BotModule, ModuleTemplateUsageSource } from "../contract";
import { settingsVariableReferences } from "../contract";
import { VOTEKICK_DEFAULT_TEXTS } from "./contracts/chat-defaults";
import { VOTEKICK_TEMPLATE_FIELDS } from "./contracts/template-variable-catalog";
import { votekickCatalog } from "./contracts/catalog";
import { VOTEKICK_MODULE_ID, votekickSettingsSchema } from "./contracts";
import { createVotekickRepository, purgeExpiredVotekickUserIds } from "./adapters/d1";
import { processVotekickMessage, closeExpiredVotekick } from "./service";
import { votekickRoutes } from "./routes";

const votekickIcon = { paths: ["M12 3v18", "M3 12h18", "m5 5 14 14", "M19 5 5 19"] } as const;
const templateFields = ["startText", "passText", "failText", "expiredText", "protectedText", "busyText"] as const;

const templateUsageSources = async (db: D1Database, channelId: string): Promise<readonly ModuleTemplateUsageSource[]> => {
  const row = await db.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?")
    .bind(channelId, VOTEKICK_MODULE_ID).first<{ settings: string }>();
  if (row === null) return [];
  let settings: unknown;
  try { settings = JSON.parse(row.settings) as unknown; } catch { return []; }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return [];
  return templateFields.flatMap((field) => {
    const text: unknown = Reflect.get(settings, field);
    return typeof text === "string" ? [{ text, kind: "event" as const, label: `votekick.${field}` }] : [];
  });
};

export const votekickModule: BotModule<typeof votekickSettingsSchema> = {
  id: VOTEKICK_MODULE_ID,
  navigationCategory: "interaction",
  panelIcon: votekickIcon,
  templateVariableGroup: { label: { de: votekickCatalog.de.name, en: votekickCatalog.en.name }, icon: votekickIcon, order: 74 },
  settingsSchema: votekickSettingsSchema,
  defaultSettings: {
    minNetVotes: 5,
    percent: 20,
    windowSeconds: 60,
    duration: { minSeconds: 120, maxSeconds: 120 },
    channelCooldownSeconds: 300,
    targetCooldownSeconds: 1800,
    chatTarget: "source_only",
    ...VOTEKICK_DEFAULT_TEXTS.en,
  },
  broadcasterScopes: ["moderation:read"],
  needsActiveChatters: true,
  eventSubTypes: ["channel.chat.message"],
  templateFields: VOTEKICK_TEMPLATE_FIELDS,
  templateContext: "event",
  templateUsageSources,
  variableReferences: settingsVariableReferences(VOTEKICK_MODULE_ID, templateFields),
  routes: votekickRoutes,
  alarms: [{
    key: "close",
    retryDelaysMs: [5_000, 15_000, 60_000],
    handle: (context, alarmKey) => closeExpiredVotekick(context, alarmKey, createVotekickRepository(context.DB)),
  }],
  scheduledMaintenance: purgeExpiredVotekickUserIds,
  navigationEntries: [{
    id: "votekick",
    label: { de: votekickCatalog.de.name, en: votekickCatalog.en.name },
    description: { de: votekickCatalog.de.description, en: votekickCatalog.en.description },
    iconKind: "votekick",
    keywords: ["votekick", "voting", "abstimmung", "timeout"],
  }],
  panel: () => import("./panel"),
  settingsEditor: () => import("./panel/settings-editor"),
  handleEvent: (event, context) => processVotekickMessage(event, createVotekickRepository(context.DB), context),
};
