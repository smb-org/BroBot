// Der Cron in wrangler.jsonc läuft stündlich. Die Wartung erneuert den Bot-
// Token, sobald weniger als eine Stunde Restlaufzeit verbleibt.
export const BOT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
export const BOT_TOKEN_REFRESH_THRESHOLD_MS = BOT_MAINTENANCE_INTERVAL_MS;
export const BOT_MAINTENANCE_STALE_AFTER_MS = BOT_MAINTENANCE_INTERVAL_MS;
