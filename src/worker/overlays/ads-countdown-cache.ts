import { adCountdownStateForSchedule } from "../../modules/ads/overlay/countdown-action";
import { readAdCountdownSnapshot, writeAdCountdownState } from "../../modules/ads/adapters/countdown-state";

/** Refreshes stale countdown data, then copies a pre-migration cache if needed. */
export const hydrateCachedAdsCountdownSnapshot = async (
  env: { DB: D1Database; CHANNEL?: Env["CHANNEL"] },
  channelId: string,
): Promise<boolean> => {
  if (env.CHANNEL === undefined) return false;

  try {
    const object = env.CHANNEL.get(env.CHANNEL.idFromName(channelId));
    try {
      const refresh = await object.refreshAdScheduleForCountdown();
      if (refresh !== null && refresh.reason !== null) {
        console.warn("Ad countdown schedule refresh did not complete.", refresh.reason);
      }
    } catch (error: unknown) {
      console.warn("Ad countdown schedule refresh failed.", error);
    }
    if (await readAdCountdownSnapshot(env.DB, channelId) !== null) return false;

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
