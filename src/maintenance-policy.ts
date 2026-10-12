// The cron in wrangler.jsonc runs hourly. Token refresh and stale-maintenance
// checks use the same one-hour window.
export const TOKEN_MAINTENANCE_WINDOW_MS = 60 * 60 * 1000;
