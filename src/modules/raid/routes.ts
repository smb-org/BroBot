import { Hono } from "hono";

import type { ModuleRouteEnvironment } from "../contract";
import { raidSettingsSchema } from "./contracts";

interface RaidStateEventRow {
  code: string;
  created_at: string;
  detail_json: string;
}

interface RaidModuleRow {
  enabled: number;
  settings: string;
}

interface RaidSubscriptionRow {
  status: string;
}

const parseDetail = (json: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const textField = (detail: Record<string, unknown>, key: string): string | null =>
  typeof detail[key] === "string" && detail[key].length > 0 ? detail[key] : null;

const numberField = (detail: Record<string, unknown>, key: string): number | null =>
  typeof detail[key] === "number" && Number.isFinite(detail[key]) ? detail[key] : null;

export const raidRoutes = new Hono<ModuleRouteEnvironment>();

raidRoutes.get("/state", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const [moduleRow, subscription, events] = await Promise.all([
    context.env.DB.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'raid'")
      .bind(channelId).first<RaidModuleRow>(),
    context.env.DB.prepare(
      `SELECT status FROM eventsub_subscriptions
        WHERE channel_id = ? AND subscription_type = 'channel.raid' AND variant = 'incoming' AND version = '1'`,
    ).bind(channelId).first<RaidSubscriptionRow>(),
    context.env.DB.prepare(
      `SELECT code, created_at, detail_json FROM event_log
        WHERE channel_id = ? AND (
          (module_id = 'channel_events' AND code IN ('channel_events.raid.incoming', 'channel_events.shoutout.sent'))
          OR code IN ('host.shoutout.sent', 'raid.shoutout')
        )
        ORDER BY created_at DESC, event_id DESC
        LIMIT 100`,
    ).bind(channelId).all<RaidStateEventRow>(),
  ]);
  const settings = (() => {
    try {
      return moduleRow === null ? null : raidSettingsSchema.safeParse(JSON.parse(moduleRow.settings));
    } catch {
      return null;
    }
  })();
  const parsedSettings = settings !== null && settings.success ? settings.data : null;
  const lastRaid = events.results.find((event) => event.code === "channel_events.raid.incoming");
  const lastShoutout = events.results.find((event) => [
    "channel_events.shoutout.sent",
    "host.shoutout.sent",
    "raid.shoutout",
  ].includes(event.code));

  return context.json({
    ready: moduleRow?.enabled === 1 && subscription?.status === "enabled",
    shoutoutThreshold: parsedSettings?.shoutoutThreshold ?? null,
    lastRaid: lastRaid === undefined ? null : {
      channel: textField(parseDetail(lastRaid.detail_json), "source"),
      viewers: numberField(parseDetail(lastRaid.detail_json), "viewers"),
      at: lastRaid.created_at,
    },
    lastShoutout: lastShoutout === undefined ? null : {
      channel: textField(parseDetail(lastShoutout.detail_json), "target"),
      at: lastShoutout.created_at,
    },
  });
});
