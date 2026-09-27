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
