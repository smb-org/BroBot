import { Hono } from "hono";
import { hasRequiredChannelRole } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { openBossFightRound, loadEnabledBossFightSettings } from "./service";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const bossFightRoutes = new Hono<ModuleRouteEnvironment>();

const streamIsOnline = async (db: D1Database, channelId: string): Promise<boolean> =>
  (await db.prepare("SELECT state FROM channel_stream_state WHERE channel_id = ?")
    .bind(channelId).first<{ state: string }>())?.state === "online";

bossFightRoutes.get("/availability", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  if (!await streamIsOnline(context.env.DB, channelId)) return context.json({ reason: "stream_offline" as const });
  const active = await context.get("points")(channelId).rounds.active();
  return context.json({ reason: active === null ? null : "round_running" as const });
});

bossFightRoutes.get("/round", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const active = await context.get("points")(channelId).rounds.active();
  if (active === null || active.state !== "open" || active.deadlineAt === null) return context.json({ round: null });
  const data = record(active.data);
  if (data === null || !Number.isSafeInteger(data.currentHp) || !Number.isSafeInteger(data.maxHp) ||
      !Number.isSafeInteger(data.attackerCount)) return context.json({ round: null });
  return context.json({
    round: {
      id: active.roundId,
      currentHp: data.currentHp,
      maxHp: data.maxHp,
      attackers: data.attackerCount,
      closesAt: new Date(active.deadlineAt).toISOString(),
    },
  });
});

bossFightRoutes.post("/start", async (context) => {
  if (!hasRequiredChannelRole(context.get("channelRole"), "operator")) {
    return context.json({ error: "boss_fight_management_denied" }, 403);
  }
  const channelId = context.req.param("channelId") ?? "";
  const settings = await loadEnabledBossFightSettings(context.env.DB, channelId);
  if (settings === null) return context.json({ error: "module_disabled" }, 409);
  if (!await streamIsOnline(context.env.DB, channelId)) return context.json({ error: "stream_offline" }, 409);
  const points = context.get("points")(channelId);
  if (await points.rounds.active() !== null) return context.json({ error: "round_running" }, 409);
  const language = (await context.env.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
    .bind(channelId).first<{ language: "de" | "en" }>())?.language ?? "de";
  try {
    const roundId = await openBossFightRound({ settings, language, points });
    return context.json({ roundId });
  } catch (failure: unknown) {
    const message = failure instanceof Error ? failure.message : "round_start_failed";
    if (message === "round_active" || message === "module_closed") return context.json({ error: message }, 409);
    return context.json({ error: "round_start_failed" }, 500);
  }
});

