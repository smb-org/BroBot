export type {
  NewTextCommand,
  TextCommand,
  TextCommandKind,
  TextCommandMinimumTier,
  TextCommandChange,
  TextCommandClaim,
  TextCommandActor,
  TextCommandResponseType,
  TextCommandStreamCondition,
} from "./contracts";
export {
  TEXT_COMMAND_MAX_ALIASES,
  TEXT_COMMAND_MINIMUM_TIERS,
  TEXT_COMMAND_RESPONSE_TYPES,
  TEXT_COMMAND_STREAM_CONDITIONS,
  TEXT_COMMAND_TEMPLATE_FIELDS,
} from "./contracts";
export type { TextCommandRepository } from "./repository";

import { z } from "zod";

import type { BotModule } from "../contract";
import { createTextCommandRepository, initializeListCommand, listTextCommandTemplateUsageSources } from "./adapters/d1";
import { textCommandRoutes } from "./routes";
import { processTextCommandMessage } from "./service";
import type { ModuleVariableReferences } from "../contract";

const variableReferences: ModuleVariableReferences = {
  async usages(db, channelId, name) {
    const token = `{var.${name}}`;
    const rows = await db.prepare(
      `SELECT command_name, response_text, template_fields_json, variable_name, variable_operation, variable_amount
         FROM text_commands
        WHERE channel_id = ?
          AND (variable_name = ? OR instr(response_text, ?) > 0 OR instr(template_fields_json, ?) > 0)
        ORDER BY command_name`,
    ).bind(channelId, name, token, token).all<{
      command_name: string;
      response_text: string;
      template_fields_json: string;
      variable_name: string | null;
      variable_operation: string | null;
      variable_amount: number | null;
    }>();
    return rows.results.flatMap((row) => [
      ...(row.variable_name === name ? [{ moduleId: "text_commands", itemName: `!${row.command_name}`, kind: "action" as const }] : []),
      ...(row.response_text.includes(token) || row.template_fields_json.includes(token)
        ? [{ moduleId: "text_commands", itemName: `!${row.command_name}`, kind: "template" as const }]
        : []),
    ]);
  },
  rename(db, channelId, from, to) {
    const oldToken = `{var.${from}}`;
    const nextToken = `{var.${to}}`;
    return [db.prepare(
      `UPDATE text_commands
          SET response_text = replace(response_text, ?, ?),
              template_fields_json = replace(template_fields_json, ?, ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              revision = revision + 1
        WHERE channel_id = ?
          AND (variable_name = ? OR instr(response_text, ?) > 0 OR instr(template_fields_json, ?) > 0)
          AND EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)
          AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)`,
    ).bind(oldToken, nextToken, oldToken, nextToken, channelId, to, oldToken, oldToken,
      channelId, to, channelId, from)];
  },
};

const settingsSchema = z.object({});

export const textCommandModule: BotModule<typeof settingsSchema> = {
  id: "text_commands",
  templateContext: "chat_command",
  templateUsageSources: listTextCommandTemplateUsageSources,
  variableReferences,
  settingsSchema,
  defaultSettings: {},
  eventSubTypes: ["channel.chat.message"],
  onEnable: (context, channelId) => initializeListCommand(
    context.DB,
    channelId,
    context.actor,
    context.now,
    context.authorizeMutation,
    context.prepareModuleAudit,
  ),
  routes: textCommandRoutes,
  panel: () => import("./panel"),
  handleEvent: (event, context) => processTextCommandMessage(
    event,
    createTextCommandRepository(context.DB, context.authorizeMutation),
    context,
  ),
};
