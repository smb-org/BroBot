import type { DryRunEntryReport } from "../../contracts/dry-run";
import type { BotModule, ModuleDryRunContext, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { DISCORD_COMMAND, DISCORD_LINK_PAGE_PATH, DISCORD_MODULE_ID, discordSettingsSchema } from "./contracts";
import { discordCatalog } from "./locale";
import { discordServerRoutes } from "./routes";

const settingsSchema = discordSettingsSchema;

const isDiscordCommand = (event: ModuleEvent): boolean => {
  if (event.subscriptionType !== "channel.chat.message") return false;
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const text: unknown = (message as { text?: unknown }).text;
  return typeof text === "string" && text.trim().split(/\s+/u, 1)[0]?.toLowerCase() === DISCORD_COMMAND;
};

const dryRunDiscordMessage = (
  event: ModuleEvent,
  context: ModuleDryRunContext,
): Promise<readonly DryRunEntryReport[]> => Promise.resolve(!isDiscordCommand(event) ? [] : [{
  moduleId: DISCORD_MODULE_ID,
  entry: { kind: "text_command", id: "discord", label: DISCORD_COMMAND },
  // The dry run has no public origin; the reply carries the absolute link page URL only in production.
  outcome: "indeterminate",
  match: { kind: "command_name", token: DISCORD_COMMAND },
  blocks: [],
  effects: [{
    kind: "chat",
    text: DISCORD_LINK_PAGE_PATH,
    target: context.defaultChatTarget,
    postsTo: "this_chat",
    reply: false,
    suppressedBy: null,
    automated: false,
  }],
  templateNotes: [{ code: "template.deferred_live", detail: { name: "discord.link_url" } }],
}]);

export const processDiscordMessage = (
  event: ModuleEvent,
  context: Pick<ModuleExecutionContext, "environment">,
): ModuleResult => {
  if (!isDiscordCommand(event)) return { actions: [], diagnostics: [] };
  const origin = context.environment?.PUBLIC_ORIGIN;
  if (typeof origin !== "string" || origin.length === 0) return { actions: [], diagnostics: [] };
  return {
    actions: [{ kind: "chat", text: new URL(DISCORD_LINK_PAGE_PATH, origin).toString(), automated: false }],
    diagnostics: [],
  };
};

export const discordModule: BotModule<typeof settingsSchema> = {
  id: DISCORD_MODULE_ID,
  navigationCategory: "admin",
  panelIcon: { paths: ["M16 8a6 6 0 0 1-8 5.66", "M8 16a6 6 0 0 1 8-5.66", "M7 10h.01", "M17 14h.01", "M12 12h.01"] },
  defaultEnabled: false,
  settingsSchema,
  defaultSettings: {},
  chatCommands: [{
    name: DISCORD_COMMAND,
    syntax: DISCORD_COMMAND,
    description: { de: discordCatalog.de.commandDescription, en: discordCatalog.en.commandDescription },
    minimumChatStatus: "everyone",
  }],
  eventSubTypes: ["channel.chat.message"],
  dryRunChatMessage: dryRunDiscordMessage,
  handleEvent: (event, context) => Promise.resolve(processDiscordMessage(event, context)),
  routes: discordServerRoutes,
  panel: () => import("./panel"),
};
