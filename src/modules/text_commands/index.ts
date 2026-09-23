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
  TEXT_COMMAND_VARIABLES,
  TEXT_COMMAND_UPTIME_VARIABLES,
  TEXT_COMMAND_FOLLOWAGE_VARIABLES,
  TEXT_COMMAND_GAME_VARIABLES,
  TEXT_COMMAND_SHOUTOUT_VARIABLES,
} from "./contracts";
export type { TextCommandRepository } from "./repository";

import { z } from "zod";

import type { BotModule } from "../contract";
import { createTextCommandRepository, initializeListCommand } from "./adapters/d1";
import { textCommandRoutes } from "./routes";
import { processTextCommandMessage } from "./service";

const settingsSchema = z.object({});

export const textCommandModule: BotModule<typeof settingsSchema> = {
  id: "text_commands",
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
