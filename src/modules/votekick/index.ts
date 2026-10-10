import type { BotModule, JsonObject, ModuleTemplateUsageSource } from "../contract";
import { settingsVariableReferences } from "../contract";
import { VOTEKICK_TEMPLATE_FIELDS } from "./contracts/template-variable-catalog";
import { votekickCatalog } from "./contracts/catalog";
import { VOTEKICK_CHAT_COMMANDS } from "./contracts/chat-commands";
import { DEFAULT_VOTEKICK_SETTINGS, VOTEKICK_HISTORY_DAYS, VOTEKICK_MODULE_ID, votekickSettingsSchema } from "./contracts";
import { createVotekickRepository, purgeExpiredVotekickUserIds } from "./adapters/d1";
import { processVotekickMessage, closeExpiredVotekick, votekickOverlayPayload } from "./service";
import { votekickRoutes } from "./routes";
import { votekickOverlayElements } from "./overlay/element";
import { VOTEKICK_ELEMENT_KIND } from "./overlay/kinds";

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

const initialVotekickOverlayState = async (db: D1Database, channelId: string): Promise<JsonObject | null> => {
  const repository = createVotekickRepository(db);
  const running = await repository.running(channelId);
  if (running !== null) return votekickOverlayPayload(running);
  const cutoff = new Date(Date.now() - VOTEKICK_HISTORY_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const latest = (await repository.listRecent(channelId, cutoff))[0];
  return latest === undefined ? null : votekickOverlayPayload(latest);
};

export const votekickModule: BotModule<typeof votekickSettingsSchema> = {
  id: VOTEKICK_MODULE_ID,
  navigationCategory: "interaction",
  panelIcon: votekickIcon,
  chatCommands: VOTEKICK_CHAT_COMMANDS,
  templateVariableGroup: { label: { de: votekickCatalog.de.name, en: votekickCatalog.en.name }, icon: votekickIcon, order: 74 },
  settingsSchema: votekickSettingsSchema,
  defaultSettings: DEFAULT_VOTEKICK_SETTINGS,
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
  overlayElements: votekickOverlayElements.map((element) => ({
    ...element,
    kind: VOTEKICK_ELEMENT_KIND,
    initialState: (db: D1Database, channelId: string) =>
      initialVotekickOverlayState(db, channelId),
  })),
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
  settingsEditorRelatedParts: ["panel"],
  handleEvent: (event, context) => processVotekickMessage(event, createVotekickRepository(context.DB), context),
};
