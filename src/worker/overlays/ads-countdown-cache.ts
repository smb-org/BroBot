import { adCountdownStateForSchedule } from "../../modules/ads/overlay/countdown-action";
import { readAdCountdownSnapshot, writeAdCountdownState } from "../../modules/ads/adapters/countdown-state";

/** Copies a pre-migration Durable Object schedule into the first D1 snapshot. */
export const hydrateCachedAdsCountdownSnapshot = async (
  env: { DB: D1Database; CHANNEL?: Env["CHANNEL"] },
  channelId: string,
): Promise<boolean> => {
  if (await readAdCountdownSnapshot(env.DB, channelId) !== null || env.CHANNEL === undefined) return false;

  try {
    const object = env.CHANNEL.get(env.CHANNEL.idFromName(channelId));
    const cache = await object.getCachedAdSchedule();
    if (cache === null) return false;

    const now = new Date().toISOString();
    await writeAdCountdownState(env.DB, channelId, adCountdownStateForSchedule(cache.schedule, now), cache.asOf);
    return true;
  } catch (error: unknown) {
    console.warn("Cached ad countdown snapshot could not be hydrated.", error);
    return false;
  }
};
