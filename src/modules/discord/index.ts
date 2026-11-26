import type { z } from "zod";

import type { DryRunEntryReport } from "../../contracts/dry-run";
import type { BotModule, ModuleAlarmContext, ModuleDryRunContext, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { DISCORD_COMMAND, DISCORD_LINK_PAGE_PATH, DISCORD_MODULE_ID, discordSettingsSchema } from "./contracts";
import { discordCatalog } from "./locale";
import { getDiscordLinkByTwitchUserId, getDiscordServerConnection } from "./repository";
import { discordReconcileAlarm } from "./reconcile";
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

const eventUserId = (event: ModuleEvent): string | null => {
  const userId = event.payload.user_id;
  return typeof userId === "string" && /^[0-9]{1,20}$/u.test(userId) ? userId : null;
};

const handleDiscordEvent = async (event: ModuleEvent<z.output<typeof settingsSchema>>, context: ModuleExecutionContext): Promise<ModuleResult> => {
  const command = processDiscordMessage(event, context);
  if (command.actions.length > 0 || event.subscriptionType === "channel.chat.message") return command;
  if (event.subscriptionType !== "channel.vip.add" && event.subscriptionType !== "channel.moderator.add") {
    return { actions: [], diagnostics: [] };
  }
  const twitchUserId = eventUserId(event);
  const environment = context.environment;
  if (twitchUserId === null || environment?.CHANNEL === undefined ||
      context.sendChat === undefined || !event.settings.chatHintEnabled) return { actions: [], diagnostics: [] };
  const connection = await getDiscordServerConnection(context.DB, event.channelId);
  if (connection === null) return { actions: [], diagnostics: [] };
  const rankType = event.subscriptionType === "channel.vip.add" ? "vip" : "moderator";
  const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(event.channelId));
  const eligible = await object.discordHintEligible(rankType);
  if (!eligible || await getDiscordLinkByTwitchUserId(context.DB, twitchUserId) !== null ||
      await object.discordChatHintWasSent(twitchUserId)) return { actions: [], diagnostics: [] };
  const linkUrl = new URL(DISCORD_LINK_PAGE_PATH, environment.PUBLIC_ORIGIN).toString();
  const language = (await context.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
    .bind(event.channelId).first<{ language: string }>())?.language === "en" ? "en" : "de";
  const text = `${discordCatalog[language].chatLinkHint} ${linkUrl}`;
  const sent = await context.sendChat(text, `discord-link-hint:${twitchUserId}`);
  if (sent.sent) {
    await object.recordDiscordChatHint(twitchUserId, Date.now());
    return { actions: [], diagnostics: [] };
  }
  return { actions: [], diagnostics: [] };
};

const discordBeforeDisable = async (
  context: { environment: Env; actor: { userId: string }; expectedRevision: number },
  channelId: string,
): Promise<{ deferred: boolean; remaining: number; blocked?: boolean }> => {
  const object = context.environment.CHANNEL.get(context.environment.CHANNEL.idFromName(channelId));
  const result = await object.beginDiscordTeardown(context.actor.userId, context.expectedRevision);
  if (!result.deferred && !result.blocked) await object.clearDiscordChatHints();
  return result;
};

const discordAlarmHandle = async (context: ModuleAlarmContext): Promise<unknown> => await discordReconcileAlarm(context);

export const discordModule: BotModule<typeof settingsSchema> = {
  id: DISCORD_MODULE_ID,
  navigationCategory: "admin",
  panelIcon: { paths: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", "M8 9h8", "M8 13h5"] },
  defaultEnabled: false,
  settingsSchema,
  defaultSettings: { chatHintEnabled: true },
  consumes: ["twitch_ranks"],
  reconcileAlarmKeys: { twitch_ranks: "reconcile" },
  broadcasterScopeAlternatives: [["channel:read:vips", "channel:manage:vips"], ["moderation:read"]],
  chatCommands: [{
    name: DISCORD_COMMAND,
    syntax: DISCORD_COMMAND,
    description: { de: discordCatalog.de.commandDescription, en: discordCatalog.en.commandDescription },
    minimumChatStatus: "everyone",
  }],
  eventSubTypes: ["channel.chat.message", "channel.vip.add", "channel.vip.remove", "channel.moderator.add", "channel.moderator.remove"],
  dryRunChatMessage: dryRunDiscordMessage,
  handleEvent: handleDiscordEvent,
  alarms: [{
    key: "reconcile",
    job: {
      intervalMs: 60 * 60_000,
      label: { de: "Discord-Rollen abgleichen", en: "Reconcile Discord roles" },
      requiredScopes: ["moderation:read"],
      requiredScopeAlternatives: [["channel:read:vips", "channel:manage:vips"]],
    },
    retryDelaysMs: [60_000, 5 * 60_000, 15 * 60_000],
    handle: discordAlarmHandle,
  }],
  beforeDisable: discordBeforeDisable,
  onActivationChange: async (context, channelId, enabled) => {
    const object = context.environment.CHANNEL.get(context.environment.CHANNEL.idFromName(channelId));
    if (enabled) {
      await object.cancelDiscordTeardown(context.revision);
      await object.markDiscordReconcileNeededAndRun();
    } else await object.finishDiscordImmediateDisable(context.revision);
  },
  routes: discordServerRoutes,
  panel: () => import("./panel"),
  panelManagesSettings: true,
};
