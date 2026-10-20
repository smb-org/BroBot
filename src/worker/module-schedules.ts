import type { ModuleScheduleInputChangeReason } from "../modules/contract";

export const notifyModuleScheduleInputsChanged = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  if (namespace === undefined) return;
  const object = namespace.get(namespace.idFromName(channelId)) as unknown as {
    notifyScheduleInputsChanged?: (value: ModuleScheduleInputChangeReason) => Promise<void>;
  };
  if (typeof object.notifyScheduleInputsChanged === "function") await object.notifyScheduleInputsChanged(reason);
};

export const reconcileChannelTimerSchedules = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
): Promise<void> => {
  if (namespace === undefined) return;
  const object = namespace.get(namespace.idFromName(channelId)) as unknown as {
    reconcileTimerSchedules?: (reason: "activation") => Promise<void>;
  };
  if (typeof object.reconcileTimerSchedules === "function") await object.reconcileTimerSchedules("activation");
};
