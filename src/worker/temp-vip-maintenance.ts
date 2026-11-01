interface TempVipExpiryStub {
  runTempVipExpiry: (now: string) => Promise<unknown>;
}

/** Wakes the channel objects that own expiry state; Twitch calls stay in each DO. */
export const maintainTempVipExpiries = async (env: Env, now: string): Promise<void> => {
  const enabled = await env.DB.prepare(
    `SELECT channel_id FROM channel_modules
      WHERE module_id = 'temp_vips' AND enabled = 1
      ORDER BY channel_id`,
  ).all<{ channel_id: string }>();

  for (const { channel_id: channelId } of enabled.results) {
    try {
      const object = env.CHANNEL.get(env.CHANNEL.idFromName(channelId)) as unknown as TempVipExpiryStub;
      await object.runTempVipExpiry(now);
    } catch (error: unknown) {
      console.warn("Temporary VIP expiry maintenance remains pending.", channelId, error);
    }
  }
};
