// The cron in wrangler.jsonc runs hourly. Maintenance renews the bot
// token once less than one hour of remaining lifetime is left.
export const BOT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
export const BOT_TOKEN_REFRESH_THRESHOLD_MS = BOT_MAINTENANCE_INTERVAL_MS;
export const BOT_MAINTENANCE_STALE_AFTER_MS = BOT_MAINTENANCE_INTERVAL_MS;
export const APP_TOKEN_REFRESH_THRESHOLD_MS = BOT_MAINTENANCE_INTERVAL_MS;
