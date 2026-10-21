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

export const reconcileChannelTimerSchedules = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
): Promise<void> => {
  if (namespace === undefined) return;
  const object = namespace.get(namespace.idFromName(channelId));
  await object.reconcileTimerSchedules("activation");
};
