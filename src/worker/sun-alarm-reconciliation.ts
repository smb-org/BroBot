interface UnscheduledSunChannel {
  channel_id: string;
}

/** Retry DO alarm registration after a settings save could not reach the channel object. */
export const reconcileUnscheduledSunAlarms = async (
  db: D1Database,
  refreshModuleAlarms: (channelId: string) => Promise<void>,
): Promise<void> => {
  const channels = await db.prepare(
    `SELECT channel_id
       FROM sun_locations
      WHERE name IS NOT NULL AND next_refresh_at IS NULL
      ORDER BY channel_id`,
  ).all<UnscheduledSunChannel>();

  await Promise.all(channels.results.map(async ({ channel_id }) => {
    try {
      await refreshModuleAlarms(channel_id);
    } catch (error: unknown) {
      // The next scheduled reconciliation will retry this channel.
      console.error("Sun refresh alarm reconciliation failed.", { channelId: channel_id, error });
    }
  }));
};
