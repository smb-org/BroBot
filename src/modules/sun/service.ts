import { validChannelTimeZone } from "../contract";
import type { SunDay } from "./domain";
import { calculateSunDay, channelLocalDate, nextSunRefreshAt, shiftLocalDate, sunRecordExpiryAt } from "./domain";
import { readSunSettings, sunDayInsert } from "./adapters/d1";

interface ChannelTimeZoneRow { time_zone: string; }
interface SunLocationRefreshRow {
  name: string;
  latitude: number;
  longitude: number;
  revision: number;
}

export interface SunRefreshResult {
  refreshed: boolean;
  nextRefreshAt: string | null;
  days: readonly SunDay[];
}

export const refreshSunRecord = async (db: D1Database, channelId: string, now = Date.now()): Promise<SunRefreshResult> => {
  const [settings, channel] = await Promise.all([
    db.prepare("SELECT name, latitude, longitude, revision FROM sun_locations WHERE channel_id = ?")
      .bind(channelId).first<SunLocationRefreshRow>(),
    db.prepare("SELECT time_zone FROM channels WHERE channel_id = ?").bind(channelId).first<ChannelTimeZoneRow>(),
  ]);
  if (settings === null || channel === null || !validChannelTimeZone(channel.time_zone)) {
    return { refreshed: false, nextRefreshAt: null, days: [] };
  }

  const timeZone = channel.time_zone;
  const today = channelLocalDate(now, timeZone);
  const tomorrow = shiftLocalDate(today, 1);
  const days = [today, tomorrow].map((localDate) => calculateSunDay({
    latitude: settings.latitude,
    longitude: settings.longitude,
    localDate,
    timeZone,
  }));
  const fetchedAt = new Date(now).toISOString();
  const expiresAt = new Date(sunRecordExpiryAt(today, timeZone)).toISOString();
  const nextRefresh = new Date(nextSunRefreshAt(now, timeZone)).toISOString();
  await db.batch([
    db.prepare(`DELETE FROM sun_times
      WHERE channel_id = ?
        AND EXISTS (SELECT 1 FROM sun_locations WHERE channel_id = ? AND revision = ? AND name IS NOT NULL)`)
      .bind(channelId, channelId, settings.revision),
    ...days.map((day) => sunDayInsert(db, channelId, day, {
      fetchedAt,
      expiresAt,
      channelTimeZone: timeZone,
      locationRevision: settings.revision,
    })),
    db.prepare(`UPDATE sun_locations
                   SET next_refresh_at = ?
                 WHERE channel_id = ? AND revision = ?
                   AND EXISTS (SELECT 1 FROM sun_locations WHERE channel_id = ? AND revision = ? AND name IS NOT NULL)`)
      .bind(nextRefresh, channelId, settings.revision, channelId, settings.revision),
  ]);
  const stored = await db.prepare(
    "SELECT COUNT(*) AS count FROM sun_times WHERE channel_id = ? AND location_revision = ? AND channel_time_zone = ?",
  ).bind(channelId, settings.revision, timeZone).first<{ count: number }>();
  return { refreshed: stored?.count === 2, nextRefreshAt: nextRefresh, days };
};

export const handleSunAlarm = async (db: D1Database, channelId: string, now: number): Promise<void> => {
  const settings = await readSunSettings(db, channelId);
  if (settings.location === null) return;
  try {
    const result = await refreshSunRecord(db, channelId, now);
    if (result.refreshed) return;
  } catch {
    // The existing two-day record remains untouched when a refresh fails.
  }
  const retryAt = new Date(now + 5 * 60_000).toISOString();
  await db.prepare("UPDATE sun_locations SET next_refresh_at = ? WHERE channel_id = ?")
    .bind(retryAt, channelId).run();
};
