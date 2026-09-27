import { Hono } from "hono";

import { MANAGING_ROLES, canManage } from "../../contracts/values";
import type { ModuleChannelLocation } from "../../modules/contract";
import { readBoundedJsonResponse, validChannelTimeZone } from "../../modules/contract";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "../auth/guards";
import { actorGuard, bindActorGuard } from "../db/guards";
import { prepareAudit } from "../db/audit";
import { readChannelLocation } from "../db/channel-settings";
import { publishOverlayHostEvent } from "../realtime";

interface ChannelLocationEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

interface GeocodingResponse {
  results?: readonly {
    name?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    timezone?: unknown;
    country?: unknown;
    admin1?: unknown;
  }[];
}

const locationFrom = (value: unknown): ModuleChannelLocation | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = record.name;
  const latitude = record.latitude;
  const longitude = record.longitude;
  const timeZone = record.timeZone;
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 160 ||
      typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      typeof timeZone !== "string" || timeZone.length > 80 || !validChannelTimeZone(timeZone)) return undefined;
  return { name: name.trim(), latitude, longitude, timeZone };
};

const locationSnapshot = (location: ModuleChannelLocation | null): object | null => location === null
  ? null
  : {
    locationName: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    locationTimeZone: location.timeZone,
  };

export const channelLocationRouter = new Hono<ChannelLocationEnvironment>();

channelLocationRouter.use("/api/channels/:channelId/settings/location", requireChannelAuthorization());
channelLocationRouter.use("/api/channels/:channelId/settings/location/*", requireChannelAuthorization());

channelLocationRouter.get("/api/channels/:channelId/settings/location/geocode", async (context) => {
  const query = (context.req.query("q") ?? "").trim();
  const language = context.req.query("language") === "en" ? "en" : "de";
  if (query.length < 2 || query.length > 100) return context.json({ results: [] });
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", language);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return context.json({ error: "channel_location_geocoding_unavailable" }, 503);
    const payload = await readBoundedJsonResponse<GeocodingResponse>(response);
    const results = (payload.results ?? []).flatMap((entry) => {
      const name = entry.name;
      const latitude = entry.latitude;
      const longitude = entry.longitude;
      const timeZone = entry.timezone;
      if (typeof name !== "string" || name.length === 0 || typeof latitude !== "number" || !Number.isFinite(latitude) ||
          typeof longitude !== "number" || !Number.isFinite(longitude) || typeof timeZone !== "string" ||
          !validChannelTimeZone(timeZone)) return [];
      return [{
        name,
        latitude,
        longitude,
        timeZone,
        country: typeof entry.country === "string" ? entry.country : "",
        admin1: typeof entry.admin1 === "string" && entry.admin1.length > 0 ? entry.admin1 : null,
      }];
    });
    return context.json({ results });
  } catch {
    return context.json({ error: "channel_location_geocoding_unavailable" }, 503);
  }
});

channelLocationRouter.patch("/api/channels/:channelId/settings/location", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "channel_settings_denied" }, 403);
  const body: unknown = await context.req.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return context.json({ error: "channel_location_invalid" }, 400);
  }
  const record = body as Record<string, unknown>;
  const revision = record.revision;
  const location = locationFrom(record.location);
  if (!Number.isSafeInteger(revision) || (revision as number) < 1 || location === undefined) {
    return context.json({ error: "channel_location_invalid" }, 400);
  }
  const channelId = context.req.param("channelId");
  const current = await context.env.DB.prepare(
    `SELECT location_name, location_latitude, location_longitude, location_time_zone
       FROM channels WHERE channel_id = ? AND location_revision = ?`,
  ).bind(channelId, revision).first<{
    location_name: string | null;
    location_latitude: number | null;
    location_longitude: number | null;
    location_time_zone: string | null;
  }>();
  if (current === null) return context.json({ error: "channel_location_conflict" }, 409);
  const previous = await readChannelLocation(context.env.DB, channelId);
  const changedAt = new Date().toISOString();
  const nextRevision = (revision as number) + 1;
  const mutation = context.env.DB.prepare(
    `UPDATE channels
        SET location_name = ?, location_latitude = ?, location_longitude = ?, location_time_zone = ?,
            location_revision = ?, updated_at = ?
      WHERE channel_id = ? AND location_revision = ? ${actorGuard(MANAGING_ROLES)}`,
  ).bind(
    location?.name ?? null,
    location?.latitude ?? null,
    location?.longitude ?? null,
    location?.timeZone ?? null,
    nextRevision,
    changedAt,
    channelId,
    revision,
    ...bindActorGuard(context.get("actor"), channelId, changedAt),
  );
  const audit = prepareAudit(context.env.DB, context.get("actor").userId, changedAt, channelId, null,
    "channel.location.updated", locationSnapshot(previous), locationSnapshot(location));
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) return context.json({ error: "channel_location_conflict" }, 409);
  await publishOverlayHostEvent(context.env.CHANNEL, context.env.DB, channelId, "template.data.changed");
  return context.json({ ok: true, location, locationRevision: nextRevision });
});
