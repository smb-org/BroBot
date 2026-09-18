import { Hono } from "hono";

import { parseKeyRing } from "./auth/crypto";
import { authRouter } from "./auth/routes";
import { panelRouter } from "./panel/routes";
import { scheduled } from "./scheduled";

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
const KEY_RING_SECRET_NAMES = new Set([
  "TWITCH_EVENTSUB_SECRET",
  "SESSION_COOKIE_KEYS",
  "SESSION_ENCRYPTION_KEYS",
]);
const PLACEHOLDER_PATTERN = /replace-with|example\.invalid/i;

const getMissingBindings = (env: Env): string[] =>
  REQUIRED_SECRET_NAMES.filter((name) => {
    const value = Reflect.get(env, name);
    if (typeof value !== "string" || value.length === 0 || PLACEHOLDER_PATTERN.test(value)) return true;
    if (!KEY_RING_SECRET_NAMES.has(name)) return false;
    try {
      parseKeyRing(value);
      return false;
    } catch {
      return true;
    }
  });

const app = new Hono<{ Bindings: Env }>();

app.route("/", authRouter);
app.route("/", panelRouter);

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

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
