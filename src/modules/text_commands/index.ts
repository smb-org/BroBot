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
  TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES,
} from "./contracts";
export type { TextCommandRepository } from "./repository";
export type { TextCommandTimeoutAction } from "./contracts";

import { z } from "zod";

import type { BotModule } from "../contract";
import { TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES, TEXT_COMMAND_TEMPLATE_VARIABLE_GROUP } from "./contracts/template-variable-catalog";
import { createTextCommandRepository, initializeListCommand, listTextCommandTemplateUsageSources } from "./adapters/d1";
import { textCommandRoutes } from "./routes";
import { processTextCommandMessage } from "./service";
import type { ModuleVariableReferences } from "../contract";

const variableReferences: ModuleVariableReferences = {
  async usages(db, channelId, name) {
    const token = `{var.${name}}`;
    const rows = await db.prepare(
      `SELECT command_name, response_text, template_fields_json, variable_name, variable_operation, variable_amount,
              timeout_fallback_text, timeout_reason
         FROM text_commands
        WHERE channel_id = ?
          AND (variable_name = ? OR instr(response_text, ?) > 0 OR instr(template_fields_json, ?) > 0 OR instr(timeout_fallback_text, ?) > 0 OR instr(timeout_reason, ?) > 0)
        ORDER BY command_name`,
    ).bind(channelId, name, token, token, token, token).all<{
      command_name: string;
      response_text: string;
      template_fields_json: string;
      variable_name: string | null;
      variable_operation: string | null;
      variable_amount: number | null;
      timeout_fallback_text: string | null;
      timeout_reason: string | null;
    }>();
    return rows.results.flatMap((row) => [
      ...(row.variable_name === name ? [{ moduleId: "text_commands", itemName: `!${row.command_name}`, kind: "action" as const }] : []),
      ...(row.response_text.includes(token) || row.template_fields_json.includes(token) || row.timeout_fallback_text?.includes(token) === true || row.timeout_reason?.includes(token) === true
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
              timeout_fallback_text = replace(timeout_fallback_text, ?, ?),
              timeout_reason = replace(timeout_reason, ?, ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              revision = revision + 1
        WHERE channel_id = ?
          AND (variable_name = ? OR instr(response_text, ?) > 0 OR instr(template_fields_json, ?) > 0 OR instr(timeout_fallback_text, ?) > 0 OR instr(timeout_reason, ?) > 0)
          AND EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)
          AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)`,
    ).bind(oldToken, nextToken, oldToken, nextToken, oldToken, nextToken, oldToken, nextToken, channelId, to, oldToken, oldToken, oldToken, oldToken,
      channelId, to, channelId, from)];
  },
};

const settingsSchema = z.object({});

export const textCommandModule: BotModule<typeof settingsSchema> = {
  id: "text_commands",
  navigationCategory: "chat",
  panelIcon: { paths: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z", "M12 7v10", "M8.5 10.5h7", "M8.5 13.5h5"] },
  templateContext: "chat_command",
  templateVariableGroup: TEXT_COMMAND_TEMPLATE_VARIABLE_GROUP,
  templateVariableCatalog: TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES,
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
