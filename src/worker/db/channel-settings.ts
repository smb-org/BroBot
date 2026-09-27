import type { ModuleChannelLocation } from "../../modules/contract";
import { validChannelTimeZone } from "../../modules/contract";

interface ChannelLocationRow {
  location_name: string | null;
  location_latitude: number | null;
  location_longitude: number | null;
  location_time_zone: string | null;
}

export const readChannelLocation = async (
  db: D1Database,
  channelId: string,
): Promise<ModuleChannelLocation | null> => {
  const row = await db.prepare(
    `SELECT location_name, location_latitude, location_longitude, location_time_zone
       FROM channels WHERE channel_id = ?`,
  ).bind(channelId).first<ChannelLocationRow>();
  if (row === null || row.location_name === null || row.location_latitude === null ||
      row.location_longitude === null || row.location_time_zone === null ||
      !Number.isFinite(row.location_latitude) || !Number.isFinite(row.location_longitude) ||
      !validChannelTimeZone(row.location_time_zone)) return null;
  return {
    name: row.location_name,
    latitude: row.location_latitude,
    longitude: row.location_longitude,
    timeZone: row.location_time_zone,
  };
};
