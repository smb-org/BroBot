import { Hono } from "hono";

import type { ModuleRouteEnvironment } from "../contract";
import { raidSettingsReadSchema } from "./contracts";

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
  const [moduleRow, subscription, lastRaid, lastShoutout] = await Promise.all([
    context.env.DB.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'raid'")
      .bind(channelId).first<RaidModuleRow>(),
    context.env.DB.prepare(
      `SELECT status FROM eventsub_subscriptions
        WHERE channel_id = ? AND subscription_type = 'channel.raid' AND variant = 'incoming' AND version = '1'`,
    ).bind(channelId).first<RaidSubscriptionRow>(),
    context.env.DB.prepare(
      `SELECT code, created_at, detail_json FROM event_log
        WHERE channel_id = ? AND code = 'channel_events.raid.incoming'
        ORDER BY created_at DESC, event_id DESC
        LIMIT 1`,
    ).bind(channelId).first<RaidStateEventRow>(),
    context.env.DB.prepare(
      `SELECT code, created_at, detail_json FROM event_log
        WHERE channel_id = ? AND code IN ('channel_events.shoutout.sent', 'host.shoutout.sent')
        ORDER BY created_at DESC, event_id DESC
        LIMIT 1`,
    ).bind(channelId).first<RaidStateEventRow>(),
  ]);
  const settings = (() => {
    try {
      return moduleRow === null ? null : raidSettingsReadSchema.safeParse(JSON.parse(moduleRow.settings));
    } catch {
      return null;
    }
  })();
  const parsedSettings = settings !== null && settings.success ? settings.data : null;
  const lastShoutoutChannel = lastShoutout === null ? null : (() => {
    const detail = parseDetail(lastShoutout.detail_json);
    return lastShoutout.code === "host.shoutout.sent"
      ? textField(detail, "toLogin") ?? textField(detail, "to")
      : textField(detail, "target");
  })();

  return context.json({
    ready: moduleRow?.enabled === 1 && subscription?.status === "enabled",
    shoutoutThreshold: parsedSettings?.shoutoutThreshold ?? null,
    lastRaid: lastRaid === null ? null : {
      channel: textField(parseDetail(lastRaid.detail_json), "source"),
      viewers: numberField(parseDetail(lastRaid.detail_json), "viewers"),
      at: lastRaid.created_at,
    },
    lastShoutout: lastShoutout === null ? null : {
      channel: lastShoutoutChannel,
      at: lastShoutout.created_at,
    },
  });
});
