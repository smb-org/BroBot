import type { BotModule, ModuleTemplateUsageSource } from "../contract";
import { RAID_TEMPLATE_FIELDS, raidSettingsSchema } from "./contracts";
import { DEFAULT_TEXT_LONG, DEFAULT_TEXT_SHORT } from "./contracts/chat-defaults";
import { processRaid } from "./service";
import { settingsVariableReferences } from "../contract";
import { raidTemplateVariableGroupLabels } from "./contracts/template-variable-catalog";
import { raidImmediateActionTexts } from "./action-locale";

const raidPanelIcon = { paths: ["m4 17 5-10 3 6 2-4 6 8H4Z", "M8 19h8"] } as const;

const templateUsageSources = async (db: D1Database, channelId: string): Promise<readonly ModuleTemplateUsageSource[]> => {
  const row = await db.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?")
    .bind(channelId, "raid").first<{ settings: string }>();
  if (row === null) return [];
  let settings: unknown;
  try { settings = JSON.parse(row.settings) as unknown; } catch { return []; }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return [];
  return (["textLong", "textShort"] as const).flatMap((field) => {
    const text: unknown = Reflect.get(settings, field);
    return typeof text === "string" ? [{ text, kind: "event" as const, label: `raid.${field}` }] : [];
  });
};

export { processRaid } from "./service";

export const raidModule: BotModule<typeof raidSettingsSchema> = {
  id: "raid",
  navigationCategory: "twitch",
  panelIcon: raidPanelIcon,
  templateVariableGroup: { label: raidTemplateVariableGroupLabels, icon: raidPanelIcon, order: 65 },
  settingsSchema: raidSettingsSchema,
  templateFields: RAID_TEMPLATE_FIELDS,
  templateContext: "event",
  templateUsageSources,
  variableReferences: settingsVariableReferences("raid", ["textLong", "textShort"]),
  defaultSettings: {
    shoutoutEnabled: true,
    shoutoutThreshold: 3,
    textThreshold: 3,
    textLong: DEFAULT_TEXT_LONG,
    textShort: DEFAULT_TEXT_SHORT,
    textLongTarget: "channel_default",
    textShortTarget: "channel_default",
  },
  eventSubTypes: ["channel.raid"],
  settingsEditor: () => import("./panel/settings-editor"),
  actions: [{
    id: "send-shoutout",
    name: raidImmediateActionTexts.name,
    icon: "shoutout",
    conditions: ["streamLive"],
    requiredRole: "operator",
    content: { presentation: "popover", load: () => import("./panel/action-content") },
    errorMessage: raidImmediateActionTexts.error,
    execute: async ({ channelId, formData }) => {
      const login = formData.get("login");
      if (typeof login !== "string" || login.trim().length === 0) throw new Error("A channel login is required.");
      await (await import("./panel/immediate-action-service")).sendManualShoutout(channelId, login.trim());
    },
  }],
  handleEvent: (event, context) => processRaid(event, context.renderTemplate),
};
