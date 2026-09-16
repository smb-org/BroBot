import { Hono } from "hono";

export { ChannelObject } from "./durable/ChannelObject";

const REQUIRED_SECRET_NAMES = [
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "PUBLIC_ORIGIN",
  "SESSION_COOKIE_KEYS",
  "SESSION_ENCRYPTION_KEYS",
  "OVERLAY_TOKEN_PEPPER",
] as const;
const PLACEHOLDER_PATTERN = /replace-with|example\.invalid/i;

const getMissingBindings = (env: Env): string[] =>
  REQUIRED_SECRET_NAMES.filter((name) => {
    const value = Reflect.get(env, name);
    return typeof value !== "string" || value.length === 0 || PLACEHOLDER_PATTERN.test(value);
  });

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (context) => {
  const missingBindings = getMissingBindings(context.env);
  return context.json(
    {
      status: missingBindings.length === 0 ? "ok" : "misconfigured",
      missingBindings,
    },
    missingBindings.length === 0 ? 200 : 503,
  );
});

// TODO: Hier später die Routen aus src/modules/registry.ts unter /api/modules/<id> mounten.

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export default app satisfies ExportedHandler<Env>;
