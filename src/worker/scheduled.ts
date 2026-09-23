import { maintainAppAccessToken } from "./app-token";
import { maintainBotIdentity } from "./bot-maintenance";
import { EVENT_LOG_DAILY_TRIM_HOUR, purgeOldEventLogEntries, trimEventLogToLimit } from "./event-log";
import { maintainLoginIdentities } from "./login-maintenance";
import {
  purgeOldEventSubMessages,
} from "./db/eventsub-state";
import { purgeOldTextCommandUserCooldowns } from "./db/text-command-user-cooldowns";
import { maintainEventSubSubscriptions } from "./eventsub-subscriptions";
import { eventSubMessageCutoff } from "./eventsub";

export const scheduled: NonNullable<ExportedHandler<Env>["scheduled"]> = async (
  _controller,
  env,
  executionContext,
) => {
  const now = new Date().toISOString();
  const eventSubCutoff = eventSubMessageCutoff(now);
  const userCooldownCutoff = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  const tasks = [
    purgeOldEventLogEntries(env.DB, now),
    purgeOldEventSubMessages(env.DB, eventSubCutoff),
    purgeOldTextCommandUserCooldowns(env.DB, userCooldownCutoff),
    maintainLoginIdentities(env, now),
    maintainBotIdentity(env, now),
    maintainAppAccessToken(env, now),
    maintainEventSubSubscriptions(env, now),
  ];
  // The count trim is a full-table scan (see EVENT_LOG_LIMIT's comment) --
  // cheap once a day, not something every hourly tick should pay for.
  if (new Date(now).getUTCHours() === EVENT_LOG_DAILY_TRIM_HOUR) tasks.push(trimEventLogToLimit(env.DB));
  const work = Promise.all(tasks).then(() => undefined);
  executionContext.waitUntil(work);
  await work;
};
