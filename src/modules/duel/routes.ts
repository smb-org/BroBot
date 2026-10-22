import { Hono } from "hono";
import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { DUEL_MODULE_ID } from "./contracts";

export const duelRoutes = new Hono<ModuleRouteEnvironment>();

duelRoutes.get("/rounds", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const rounds = await context.get("points")(channelId).rounds.listOpen();
  return context.json(rounds.flatMap((round) => {
    if (round.state !== "open" || round.deadlineAt === null) return [];
    const data = typeof round.data === "object" && round.data !== null ? round.data as Record<string, unknown> : null;
    if (data === null || typeof data.challengerLogin !== "string" ||
        !(data.targetLogin === null || typeof data.targetLogin === "string") || !Number.isSafeInteger(data.stake)) return [];
    return [{
      kind: "duel" as const,
      id: round.roundId,
      challenger: data.challengerLogin,
      target: data.targetLogin,
      stake: data.stake as number,
      closesAt: new Date(round.deadlineAt).toISOString(),
    }];
  }));
});

duelRoutes.post("/rounds/:id/cancel", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "duel_management_denied" }, 403);
  const channelId = context.req.param("channelId") ?? "";
  const roundId = context.req.param("id");
  const points = context.get("points")(channelId);
  const existing = (await points.rounds.listOpen()).find((round) => round.roundId === roundId);
  if (existing === undefined) return context.json({ error: "duel_not_open" }, 404);
  const cancelled = await points.rounds.cancel(roundId);
  if (cancelled === 0) return context.json({ error: "duel_not_open" }, 409);
  await context.get("writeModuleAudit")({
    channelId,
    moduleId: DUEL_MODULE_ID,
    action: "duel.round.cancelled",
    before: { state: existing.state },
    after: { state: "cancelled", roundId },
  }, new Date().toISOString());
  return context.body(null, 204);
});
