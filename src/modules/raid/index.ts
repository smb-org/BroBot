import type { BotModule, ModuleTemplateUsageSource } from "../contract";
import { RAID_TEMPLATE_FIELDS, raidSettingsSchema } from "./contracts";
import { DEFAULT_TEXT_LONG, DEFAULT_TEXT_SHORT } from "./contracts/chat-defaults";
import { processRaid } from "./service";
import { settingsVariableReferences } from "../contract";

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

export { decideRaid, renderRaidText } from "./domain";
export { processRaid } from "./service";
export { RAID_TEMPLATE_FIELDS, RAID_VARIABLES } from "./contracts";
export type { RaidSettings } from "./contracts";

export const raidModule: BotModule<typeof raidSettingsSchema> = {
  id: "raid",
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
  },
  eventSubTypes: ["channel.raid"],
  settingsEditor: () => import("./panel/settings-editor"),
  immediateActions: {
    requires: ["streamLive"],
    load: () => import("./panel/immediate-actions"),
  },
  handleEvent: (event, context) => processRaid(event, context.renderTemplate),
};
