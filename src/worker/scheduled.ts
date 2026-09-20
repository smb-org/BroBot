import { maintainAppAccessToken } from "./app-token";
import { maintainBotIdentity } from "./bot-maintenance";
import { purgeOldEventLogEntries } from "./event-log";
import { maintainLoginIdentities } from "./login-maintenance";
import { purgeOldEventSubMessages } from "./auth/repository";
import { maintainEventSubSubscriptions } from "./eventsub-subscriptions";
import { eventSubMessageCutoff } from "./eventsub";

export const scheduled: NonNullable<ExportedHandler<Env>["scheduled"]> = async (
  _controller,
  env,
  executionContext,
) => {
  const now = new Date().toISOString();
  const eventSubCutoff = eventSubMessageCutoff(now);
  const work = Promise.all([
    purgeOldEventLogEntries(env.DB, now),
    purgeOldEventSubMessages(env.DB, eventSubCutoff),
    maintainLoginIdentities(env, now),
    maintainBotIdentity(env, now),
    maintainAppAccessToken(env, now),
    maintainEventSubSubscriptions(env, now),
  ]).then(() => undefined);
  executionContext.waitUntil(work);
  await work;
};
