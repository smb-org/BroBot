export type {
  TextCommand,
  TextCommandKind,
  TextCommandMinimumTier,
} from "./contracts";
export type { TextCommandRepository } from "./repository";

import { z } from "zod";

import type { BotModule, ModuleAction, ModuleDiagnostic, ModuleDryRunContext, ModuleEvent } from "../contract";
import type { DryRunBlockCode, DryRunEffect, DryRunEntryReport } from "../../contracts/dry-run";
import { TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES, TEXT_COMMAND_TEMPLATE_VARIABLE_GROUP } from "./contracts/template-variable-catalog";
import { createTextCommandPeekRepository, createTextCommandRepository, initializeListCommand, listTextCommandTemplateUsageSources } from "./adapters/d1";
import { textCommandRoutes } from "./routes";
import { processTextCommandMessage } from "./service";
import { commandFromMessage } from "./domain";
import type { TextCommand } from "./contracts";
import { moduleVariableRenameTarget } from "../contract";
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
  rename(db, channelId, from, to, guard) {
    const oldToken = `{var.${from}}`;
    const nextToken = `{var.${to}}`;
    const target = moduleVariableRenameTarget(channelId, to, guard);
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
          AND ${target.sql}
          AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)`,
    ).bind(oldToken, nextToken, oldToken, nextToken, oldToken, nextToken, oldToken, nextToken, channelId, to, oldToken, oldToken, oldToken, oldToken,
      ...target.values, channelId, from)];
  },
};

const settingsSchema = z.object({});

const textCommandBlockCodes = new Set<string>([
  "text_commands.disabled",
  "text_commands.permission_denied",
  "text_commands.stream_state",
  "text_commands.game_filter",
  "text_commands.cooldown",
  "text_commands.user_cooldown",
  "text_commands.argument_invalid",
  "text_commands.argument_missing",
]);

const safeDiagnosticDetail = (
  detail: ModuleDiagnostic["detail"],
): Readonly<Record<string, string | number | boolean | null>> | undefined => {
  if (detail === undefined) return undefined;
  return Object.fromEntries(Object.entries(detail).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.join(",") : value,
  ])) as Readonly<Record<string, string | number | boolean | null>>;
};

const targetFor = (action: Extract<ModuleAction, { kind: "chat" | "announcement" }>, context: ModuleDryRunContext) =>
  action.target ?? context.defaultChatTarget;

const chatEffect = (
  action: Extract<ModuleAction, { kind: "chat" | "announcement" }>,
  event: ModuleEvent,
  context: ModuleDryRunContext,
): DryRunEffect => {
  const target = targetFor(action, context);
  const sourceBroadcasterId = event.payload.source_broadcaster_user_id;
  const sourceOnly = target === "source_only" || (
    target === "where_asked" &&
    (typeof sourceBroadcasterId !== "string" || sourceBroadcasterId === event.channelId)
  );
  return {
    kind: action.kind,
    text: action.text,
    target,
    postsTo: sourceOnly ? "this_chat" : "all_shared_chats",
    reply: action.kind === "chat" && action.replyToMessageId !== undefined,
    suppressedBy: null,
    automated: action.automated ?? true,
  };
};

const dryRunTextCommandMessage = async (
  event: ModuleEvent,
  context: ModuleDryRunContext,
): Promise<readonly DryRunEntryReport[]> => {
  const message = event.payload.message;
  const text = typeof message === "object" && message !== null && !Array.isArray(message)
    ? (message as Readonly<Record<string, unknown>>).text
    : null;
  if (typeof text !== "string") return [];
  const input = commandFromMessage(text);
  if (input === null || input.kind === "unknown") return [];

  const baseRepository = createTextCommandPeekRepository(context.DB);
  const matches: { command: TextCommand; alias: string | null }[] = [];
  const claims: Awaited<ReturnType<typeof baseRepository.claim>>[] = [];
  const repository = {
    ...baseRepository,
    async find(channelId: string, name: string): Promise<TextCommand | null> {
      const command = await baseRepository.find(channelId, name);
      if (command !== null) {
        matches.push({ command, alias: null });
      }
      return command;
    },
    async findByAlias(channelId: string, alias: string): Promise<TextCommand | null> {
      const command = await baseRepository.findByAlias(channelId, alias);
      if (command !== null) {
        matches.push({ command, alias });
      }
      return command;
    },
    async claim(...args: Parameters<typeof baseRepository.claim>) {
      const claim = await baseRepository.claim(...args);
      claims.push(claim);
      return claim;
    },
  };
  const result = await processTextCommandMessage(event, repository, context);
  const match = matches.at(-1);
  if (match === undefined) return [];
  const command = match.command;
  const claimResult = claims.at(-1) ?? null;

  const blocks = result.diagnostics.flatMap((diagnostic) => {
    if (!textCommandBlockCodes.has(diagnostic.code)) return [];
    const detail = safeDiagnosticDetail(diagnostic.detail);
    return [{
      code: diagnostic.code as DryRunBlockCode,
      ...(detail === undefined ? {} : { detail }),
    }];
  });
  const fires = blocks.length === 0 && result.diagnostics.some((diagnostic) => diagnostic.code === "text_commands.triggered");
  const effects: DryRunEffect[] = [];
  if (fires) {
    for (const action of result.actions) {
      if (action.kind === "chat" || action.kind === "announcement") {
        effects.push(chatEffect(action, event, context));
      } else if (action.kind === "shoutout") {
        effects.push({ kind: "shoutout", targetLogin: "targetLogin" in action ? action.targetLogin : action.targetChannelId });
      } else if (action.kind === "timeout" && command.timeoutAction !== null) {
        effects.push({
          kind: "timeout",
          minSeconds: command.timeoutAction.minSeconds,
          maxSeconds: command.timeoutAction.maxSeconds,
          reason: action.reason,
        });
        for (const followUp of [action.onSuccess, action.onFailure]) {
          if (followUp !== undefined) effects.push(chatEffect(followUp, event, context));
        }
      }
    }
    for (const change of result.variableChanges ?? []) {
      const before = await context.readChannelVariables([change.name]);
      const from = before[change.name];
      if (from !== undefined) effects.push({ kind: "variable", name: change.name, from, to: change.value });
    }
    if (claimResult?.claimed === true) {
      if (command.cooldownSeconds > 0) effects.push({ kind: "cooldown", scope: "global", seconds: command.cooldownSeconds });
      if (command.userCooldownSeconds > 0) effects.push({ kind: "cooldown", scope: "user", seconds: command.userCooldownSeconds });
    }
  }
  const templateNotes = result.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("template."));
  return [{
    moduleId: "text_commands",
    entry: { kind: "text_command", id: command.name, label: `!${command.name}` },
    outcome: fires ? "fires" : "blocked",
    match: match.alias === null
      ? { kind: "command_name", token: `!${input.name}` }
      : { kind: "alias", token: match.alias },
    blocks,
    effects,
    templateNotes,
  }];
};

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
  dryRunChatMessage: dryRunTextCommandMessage,
};
