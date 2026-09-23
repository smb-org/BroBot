export const purgeOldTextCommandUserCooldowns = async (
  db: D1Database,
  cutoff: string,
): Promise<void> => {
  await db.prepare(
    `DELETE FROM text_command_user_cooldowns
      WHERE last_used_at < ?`,
  ).bind(cutoff).run();
};
