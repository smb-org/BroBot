import { Hono } from "hono";

import { authRouter } from "./auth/routes";
import { getHealthStatus } from "./config";
import { scheduled } from "./scheduled";

export { ChannelObject } from "./durable/ChannelObject";

const app = new Hono<{ Bindings: Env }>();

app.route("/", authRouter);

app.get("/healthz", (context) => {
  const health = getHealthStatus(context.env);
  return context.json(
    {
      status: health.status,
      missingBindings: health.missingBindings,
    },
    health.statusCode,
  );
});

// TODO: Hier später die Routen aus src/modules/registry.ts unter /api/modules/<id> mounten.

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
