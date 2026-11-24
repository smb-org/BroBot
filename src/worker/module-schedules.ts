import type { ModuleScheduleInputChangeReason } from "../modules/contract";

export const notifyModuleScheduleInputsChanged = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  if (namespace === undefined) return;
  const object = namespace.get(namespace.idFromName(channelId));
  await object.notifyScheduleInputsChanged(reason);
};

/** Re-registers the channel's background jobs after a module is enabled or disabled. */
export const syncChannelJobs = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
): Promise<void> => {
  if (namespace === undefined) return;
  const object = namespace.get(namespace.idFromName(channelId));
  await object.syncChannelJobSchedules();
  await object.publishChannelJobStatusChanged();
};

export const reconcileChannelTimerSchedules = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
): Promise<void> => {
  if (namespace === undefined) return;
  const object = namespace.get(namespace.idFromName(channelId));
  await object.reconcileTimerSchedules("activation");
};
