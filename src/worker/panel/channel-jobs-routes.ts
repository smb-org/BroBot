import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import type { PanelChannelJob } from "../../panel-contract";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "../auth/guards";

interface ChannelJobsRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

export const channelJobsRouter = new Hono<ChannelJobsRouteEnvironment>();

const requireExpectedOrigin = createMiddleware<ChannelJobsRouteEnvironment>(async (context, next) => {
  const origin = context.req.header("Origin");
  let expectedOrigin: string | null;
  try {
    expectedOrigin = new URL(context.env.PUBLIC_ORIGIN).origin;
  } catch {
    expectedOrigin = null;
  }
  if (origin === undefined || expectedOrigin === null || origin !== expectedOrigin) {
    return context.json({ error: "channel_jobs_origin_invalid" }, 403);
  }
  await next();
});

const validJobId = (jobId: string): boolean =>
  jobId.length <= 256 && /^(?:module|host):[A-Za-z0-9_:-]{1,252}$/u.test(jobId);

const channelObjectFor = (env: Env, channelId: string) => {
  return env.CHANNEL.get(env.CHANNEL.idFromName(channelId));
};

channelJobsRouter.get(
  "/api/channels/:channelId/jobs",
  requireChannelAuthorization(),
  async (context) => {
    const jobs = await channelObjectFor(context.env, context.req.param("channelId")).listChannelJobs() as PanelChannelJob[];
    return context.json({ jobs });
  },
);

channelJobsRouter.post(
  "/api/channels/:channelId/jobs/:jobId/run",
  requireChannelAuthorization(),
  requireExpectedOrigin,
  async (context) => {
    const channelId = context.req.param("channelId");
    const jobId = context.req.param("jobId");
    if (!validJobId(jobId)) return context.json({ error: "channel_job_not_found" }, 404);
    const result = await channelObjectFor(context.env, channelId).runChannelJobNow(jobId);
    if (result === "not_found") return context.json({ error: "channel_job_not_found" }, 404);
    if (result === "paused") return context.json({ error: "channel_job_paused" }, 409);
    return context.json({ result });
  },
);

channelJobsRouter.post(
  "/api/channels/:channelId/jobs/:jobId/pause",
  requireChannelAuthorization(),
  requireExpectedOrigin,
  async (context) => {
    const channelId = context.req.param("channelId");
    const jobId = context.req.param("jobId");
    if (!validJobId(jobId)) return context.json({ error: "channel_job_not_found" }, 404);
    const status = await channelObjectFor(context.env, channelId).pauseChannelJob(jobId);
    if (status === null) return context.json({ error: "channel_job_not_found" }, 404);
    return context.json({ status: { state: status.state, pausedAt: status.pausedAt, reconcileNeeded: status.reconcileNeeded } });
  },
);

channelJobsRouter.post(
  "/api/channels/:channelId/jobs/:jobId/resume",
  requireChannelAuthorization(),
  requireExpectedOrigin,
  async (context) => {
    const channelId = context.req.param("channelId");
    const jobId = context.req.param("jobId");
    if (!validJobId(jobId)) return context.json({ error: "channel_job_not_found" }, 404);
    const result = await channelObjectFor(context.env, channelId).resumeChannelJob(jobId);
    if (result === "not_found") return context.json({ error: "channel_job_not_found" }, 404);
    if (result === "not_paused") return context.json({ error: "channel_job_not_paused" }, 409);
    return context.json({ result });
  },
);
