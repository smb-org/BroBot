import { Hono } from "hono";

import { authRouter } from "./auth/routes";
import { platformRouter } from "./platform/routes";
import { eventSubRouter } from "./eventsub";
import { panelRouter } from "./panel/routes";
import { realtimeRouter } from "./realtime";
import { notifyCommittedResources, PANEL_RESOURCE_NOTIFIER_COVERAGE } from "./panel-resources";
import { serverTimingMiddleware } from "./server-timing";

export const app = new Hono<{ Bindings: Env }>();
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const authorizedContextHas = (context: { var: object }, key: string): boolean =>
  Reflect.get(context.var, key) !== undefined;

app.use("/api/*", serverTimingMiddleware);
app.use(PANEL_RESOURCE_NOTIFIER_COVERAGE.channelRoutes, async (context, next) => {
  try {
    await next();
  } finally {
    const channelId = context.req.param("channelId");
    if (channelId.length > 0 && authorizedContextHas(context, "session")) {
      await notifyCommittedResources(context.env, channelId);
    }
  }
});
app.use(PANEL_RESOURCE_NOTIFIER_COVERAGE.platformRoutes, async (context, next) => {
  try {
    await next();
  } finally {
    if (mutatingMethods.has(context.req.method.toUpperCase()) && authorizedContextHas(context, "actor")) {
      await notifyCommittedResources(context.env);
    }
  }
});
app.route("/", authRouter);
app.route("/", platformRouter);
app.route("/", panelRouter);
app.route("/", eventSubRouter);
app.route("/", realtimeRouter);
