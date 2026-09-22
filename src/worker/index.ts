import { Hono } from "hono";

import { authRouter } from "./auth/routes";
import { platformRouter } from "./platform/routes";
import { getHealthStatus } from "./config";
import { eventSubRouter } from "./eventsub";
import { panelRouter } from "./panel/routes";
import { realtimeRouter } from "./realtime";
import { scheduled } from "./scheduled";

export { ChannelObject } from "./durable/ChannelObject";

const app = new Hono<{ Bindings: Env }>();

app.route("/", authRouter);
app.route("/", platformRouter);
app.route("/", panelRouter);
app.route("/", eventSubRouter);
app.route("/", realtimeRouter);

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

// Events reach modules via the EventSub inbound handler and `dispatch.ts`.
// Module routes are mounted channel-scoped from the registry in
// `panel/module-routes.ts` under `/api/channels/:channelId/modules/<id>`.

/**
 * An unmatched API path must not fall through to the assets. The asset handler
 * runs with `not_found_handling: single-page-application`, so it answers with
 * `index.html` and status 200 -- the caller then parses HTML as JSON and sees
 * "Unexpected token '<'" instead of a missing route. Every renamed or mistyped
 * endpoint turns into that riddle.
 */
app.all("/api/*", (context) => context.json({ error: "Unbekannte API-Route." }, 404));

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
