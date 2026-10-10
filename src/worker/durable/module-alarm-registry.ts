import type { BotModule } from "../../modules/contract";
import { BALLOT_EXPIRY_ALARM_HANDLER, BALLOT_HARD_DELETE_ALARM_HANDLER } from "./ballots";

export const ACTIVE_CHATTER_EXPIRY_HANDLER = "channel.active_chatters_expiry";
export const SECURITY_ROUND_HANDLER = "channel.security_round";
export const SECURITY_RETRY_HANDLER = "channel.security_retry";
export const AD_PREWARNING_HANDLER = "channel.ad_prewarning";
export const AD_COUNTDOWN_REFRESH_HANDLER = "channel.ad_countdown_refresh";
export const MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER = "channel.module_schedule_inputs_changed";

// Every host alarm scheduled by ChannelObject has a matching runtime handler.
// Keep this registry beside the module registry so coverage can compare the
// scheduler's complete declared set with the handlers built at runtime.
export const CHANNEL_HOST_ALARM_HANDLER_KEYS = [
  ACTIVE_CHATTER_EXPIRY_HANDLER,
  BALLOT_EXPIRY_ALARM_HANDLER,
  BALLOT_HARD_DELETE_ALARM_HANDLER,
  SECURITY_ROUND_HANDLER,
  SECURITY_RETRY_HANDLER,
  AD_PREWARNING_HANDLER,
  AD_COUNTDOWN_REFRESH_HANDLER,
  MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER,
] as const;

export const missingAlarmHandlerKeys = (
  scheduled: readonly string[],
  registered: Iterable<string>,
): string[] => {
  const registeredKeys = new Set(registered);
  return [...new Set(scheduled)].filter((key) => !registeredKeys.has(key));
};

export const moduleAlarmHandlerEntries = (modules: readonly BotModule[]) => modules.flatMap((module) =>
  (module.alarms ?? []).map((registration) => ({ moduleId: module.id, registration })));
