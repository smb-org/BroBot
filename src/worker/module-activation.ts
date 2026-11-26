import type { BotModule } from "../modules/contract";
import type { ActorContext } from "./db/guards";
import { maintainEventSubSubscriptions } from "./eventsub-subscriptions";
import { publishOverlayChangedWithResult } from "./realtime";
import { notifyModuleScheduleInputsChanged, syncChannelJobs } from "./module-schedules";
import { authorizeModuleManagementMutation } from "./module-authorization";

const logFailure = (moduleId: string, step: string, error: unknown): void => {
  console.error("Module activation post-commit step failed.", {
    moduleId,
    step,
    error: error instanceof Error ? error.message : String(error),
  });
};

const runStep = async (moduleId: string, step: string, action: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await action();
  } catch (error) {
    logFailure(moduleId, step, error);
    return undefined;
  }
};

export interface ModuleActivationPostCommitOperations {
  notifyScheduleInputsChanged: () => Promise<void>;
  syncChannelJobs: () => Promise<void>;
  publishOverlays: () => Promise<void>;
  maintainEventSubSubscriptions: () => Promise<void>;
}

export const publishModuleActivationOverlays = async (
  environment: Env,
  channelId: string,
  module: BotModule,
): Promise<void> => {
  const overlayKinds = module.overlayElements?.map(({ kind }) => kind) ?? [];
  if (overlayKinds.length === 0) return;
  const placeholders = overlayKinds.map(() => "?").join(", ");
  const affected = await environment.DB.prepare(
    `SELECT DISTINCT overlay.overlay_id AS overlayId, overlay.revision
       FROM overlays AS overlay
       JOIN overlay_elements AS element
         ON element.channel_id = overlay.channel_id AND element.overlay_id = overlay.overlay_id
      WHERE overlay.channel_id = ? AND element.kind IN (${placeholders})
      ORDER BY overlay.overlay_id`,
  ).bind(channelId, ...overlayKinds).all<{ overlayId: string; revision: number }>();
  const published = await publishOverlayChangedWithResult(environment.CHANNEL, channelId, affected.results);
  if (!published.ok) throw published.error;
};

export const runModuleActivationPostCommit = async (input: {
  environment: Env;
  channelId: string;
  module: BotModule;
  enabled: boolean;
  previousEnabled: boolean;
  actor: ActorContext;
  now: string;
  revision: number;
  runModuleAlarm: (handlerKey: string, alarmKey: string, invocation?: unknown) => Promise<unknown>;
  operations: ModuleActivationPostCommitOperations;
}): Promise<unknown> => {
  const { environment, channelId, module, enabled, previousEnabled, actor, now, revision, runModuleAlarm, operations } = input;
  const changed = previousEnabled !== enabled;
  if (module.id === "belabox" && module.settingsChangedAlarm !== undefined) {
    await runStep(module.id, "module_alarm", () => runModuleAlarm(
      module.settingsChangedAlarm?.handlerKey ?? "",
      module.settingsChangedAlarm?.alarmKey ?? "",
    ));
  } else if (changed) {
    await runStep(module.id, "schedule_notification", operations.notifyScheduleInputsChanged);
  }
  if (changed) await runStep(module.id, "channel_job_schedule", operations.syncChannelJobs);
  await runStep(module.id, "overlay_publish", operations.publishOverlays);
  let activationResult: unknown;
  if (module.onActivationChange !== undefined) {
    activationResult = await runStep(module.id, "activation_change", async () => await module.onActivationChange?.({
      DB: environment.DB,
      environment,
      authorizeMutation: authorizeModuleManagementMutation,
      actor,
      now,
      revision,
      runModuleAlarm,
    }, channelId, enabled));
  }
  await runStep(module.id, "eventsub_reconciliation", operations.maintainEventSubSubscriptions);
  return activationResult;
};

export const defaultModuleActivationOperations = (
  environment: Env,
  channelId: string,
  module: BotModule,
  now: string,
): ModuleActivationPostCommitOperations => ({
  notifyScheduleInputsChanged: async () => { await notifyModuleScheduleInputsChanged(environment.CHANNEL, channelId, "activation"); },
  syncChannelJobs: async () => { await syncChannelJobs(environment.CHANNEL, channelId); },
  publishOverlays: async () => { await publishModuleActivationOverlays(environment, channelId, module); },
  maintainEventSubSubscriptions: async () => { await maintainEventSubSubscriptions(environment, now, fetch, channelId); },
});
