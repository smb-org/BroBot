import { maintainAppAccessToken } from "./app-token";
import { maintainBotIdentity } from "./bot-maintenance";
import { purgeOldEventLogEntries } from "./event-log";
import { maintainLoginIdentities } from "./login-maintenance";
import { purgeOldEventSubMessages } from "./auth/repository";
import { maintainEventSubSubscriptions } from "./eventsub-subscriptions";

export const scheduled: NonNullable<ExportedHandler<Env>["scheduled"]> = async (
  _controller,
  env,
  executionContext,
) => {
  const now = new Date().toISOString();
  const eventSubCutoff = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
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
