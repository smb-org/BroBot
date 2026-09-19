import { Hono } from "hono";

import { authRouter } from "./auth/routes";
import { getHealthStatus } from "./config";
import { panelRouter } from "./panel/routes";
import { scheduled } from "./scheduled";

export { ChannelObject } from "./durable/ChannelObject";

const app = new Hono<{ Bindings: Env }>();

app.route("/", authRouter);
app.route("/", panelRouter);

app.get("/healthz", async (context) => {
  const health = await getHealthStatus(context.env);
  return context.json(
    {
      status: health.status,
      missingBindings: health.missingBindings,
    },
    health.statusCode,
  );
});

// TODO: Hier später die Routen aus src/modules/registry.ts unter /api/channels/:channelId/modules/<id> mounten.

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
