import type { ModuleScheduleInputChangeReason } from "../modules/contract";

export const notifyModuleScheduleInputsChanged = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  if (namespace === undefined) return;
  const object = namespace.get(namespace.idFromName(channelId));
  const notify = (object as unknown as { notifyScheduleInputsChanged?: (value: ModuleScheduleInputChangeReason) => Promise<void> })
    .notifyScheduleInputsChanged;
  if (typeof notify === "function") await notify.call(object, reason);
};

export const reconcileChannelTimerSchedules = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
): Promise<void> => {
  if (namespace === undefined) return;
  const object = namespace.get(namespace.idFromName(channelId));
  const reconcile = (object as unknown as { reconcileTimerSchedules?: (reason: "activation") => Promise<void> })
    .reconcileTimerSchedules;
  if (typeof reconcile === "function") await reconcile.call(object, "activation");
};
