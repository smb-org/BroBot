import { maintainBotIdentity } from "./bot-maintenance";
import { maintainLoginIdentities } from "./login-maintenance";

export const scheduled: NonNullable<ExportedHandler<Env>["scheduled"]> = async (
  _controller,
  env,
  executionContext,
) => {
  const now = new Date().toISOString();
  const work = Promise.all([
    maintainLoginIdentities(env, now),
    maintainBotIdentity(env, now),
  ]).then(() => undefined);
  executionContext.waitUntil(work);
  await work;
};
