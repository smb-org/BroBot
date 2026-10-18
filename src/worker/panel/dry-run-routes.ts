import { Hono } from "hono";
import { z } from "zod";

import type { DryRunRequest } from "../../contracts/dry-run";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "../auth/guards";
import { DryRunChannelNotReleasedError, dryRunChatMessage } from "../dry-run";
import { readJsonBody } from "./member-routes";

const MAX_DRY_RUN_BODY_BYTES = 16 * 1024;

interface DryRunRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const requestSchema = z.object({
  text: z.string().min(1).max(500).refine((text) => text.trim().length > 0),
  sender: z.object({
    login: z.string().regex(/^[a-z0-9_]{1,25}$/u),
    statuses: z.array(z.enum(["subscriber", "vip", "moderator", "broadcaster"]))
      .max(4)
      .refine((statuses) => new Set(statuses).size === statuses.length),
  }).strict(),
  streamState: z.enum(["online", "offline"]),
  game: z.object({
    id: z.string().regex(/^[0-9]{1,20}$/u),
    name: z.string().trim().min(1).max(100),
  }).strict().nullable(),
  sharedChat: z.boolean(),
  only: z.object({
    moduleId: z.enum(["text_commands", "faq"]),
    entryId: z.string().min(1).max(100).optional(),
  }).strict().optional(),
}).strict();

export const dryRunRouter = new Hono<DryRunRouteEnvironment>();

dryRunRouter.use("/api/channels/:channelId/dry-run", async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
});
dryRunRouter.use("/api/channels/:channelId/dry-run", requireChannelAuthorization());

dryRunRouter.post("/api/channels/:channelId/dry-run", async (context) => {
  const parsed = requestSchema.safeParse(await readJsonBody(context.req.raw, MAX_DRY_RUN_BODY_BYTES));
  if (!parsed.success) return context.json({ error: "dry_run_invalid" }, 400);
  try {
    return context.json(await dryRunChatMessage(
      context.env,
      context.req.param("channelId"),
      parsed.data as DryRunRequest,
    ));
  } catch (error: unknown) {
    if (error instanceof DryRunChannelNotReleasedError) {
      return context.json({ error: "channel_not_released" }, 409);
    }
    throw error;
  }
});
