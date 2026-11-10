import type { ModuleExecutionContext, ModuleStreamState } from "../modules/contract";
import { modulePoints } from "./module-points";
import { moduleBallots } from "./module-ballots";
import { moduleTempVips } from "./module-temp-vips";
import { authorizeModuleMutation } from "./module-authorization";
import { readChannelStreamState } from "./db/stream-state";
import { prepareChannelVariableChange, readChannelVariables } from "./db/channel-variables";
import { secureRandomInteger } from "./template-resolver";

/** Builds the worker-owned, channel-scoped context used by action retries outside EventSub dispatch. */
export const createModuleActionExecutionContext = (
  environment: Env,
  channelId: string,
  moduleId: string,
): ModuleExecutionContext => {
  const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId));
  const context: Partial<ModuleExecutionContext> = {
    DB: environment.DB,
    environment,
    channelId,
    authorizeMutation: authorizeModuleMutation,
    ballots: moduleBallots(environment.CHANNEL, channelId, moduleId),
    points: modulePoints(environment.CHANNEL, channelId, moduleId),
    tempVips: moduleTempVips(environment.CHANNEL, channelId),
    sendChat: (text, operationId) => object.sendModuleChatMessage(moduleId, operationId, text),
    streamState: async (): Promise<ModuleStreamState> => {
      const state = await readChannelStreamState(environment.DB, channelId);
      return state?.state ?? "unknown";
    },
    chatActivityCount: () => object.getChatActivityCount(),
    activeChatters: {
      count: async (windowMs) => await object.getActiveChatterCount(windowMs),
      seen: async (userId) => await object.getActiveChatter(userId),
    },
    channelLanguage: async () => {
      const row = await environment.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
        .bind(channelId).first<{ language: string }>();
      return row?.language === "de" ? "de" : "en";
    },
    channelTimeZone: async () => {
      const row = await environment.DB.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
        .bind(channelId).first<{ time_zone: string | null }>();
      return row?.time_zone ?? "Europe/Berlin";
    },
    channelInfo: () => Promise.resolve(null),
    channelGameId: () => Promise.resolve(null),
    followedAt: () => Promise.resolve(null),
    followerTotal: () => Promise.resolve(null),
    chattersTotal: () => Promise.resolve(null),
    userCreatedAt: () => Promise.resolve(null),
    readChannelVariables: (names) => readChannelVariables(environment.DB, channelId, names),
    renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
    prepareVariableChange: (_targetChannelId, change, now, claim) =>
      prepareChannelVariableChange(environment.DB, channelId, change, now, claim),
    secureRandomInteger,
    scheduleAlarm: async (handlerKey, alarmKey, deadline, ownerRevision, streamGeneration, identity, planSequence) => {
      await object.scheduleModuleAlarm(moduleId, handlerKey, alarmKey, deadline, ownerRevision, streamGeneration, identity, planSequence);
    },
    clearAlarm: async (alarmKey, ownerRevision, streamGeneration, identity, planSequence) => {
      await object.clearModuleAlarm(moduleId, alarmKey, ownerRevision, streamGeneration, identity, planSequence);
    },
    getAlarmDeadline: (alarmKey) => object.getModuleAlarmDeadline(moduleId, alarmKey),
    getAlarmPlan: (alarmKey) => object.getModuleAlarmPlan(moduleId, alarmKey),
    runModuleAlarm: (handlerKey, alarmKey, invocation) => invocation === undefined
      ? object.runModuleAlarm(moduleId, handlerKey, alarmKey)
      : object.runModuleAlarm(moduleId, handlerKey, alarmKey, invocation),
  };
  context.forModule = (targetModuleId) => createModuleActionExecutionContext(environment, channelId, targetModuleId);
  return context as ModuleExecutionContext;
};
