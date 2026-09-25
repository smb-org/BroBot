import { Hono } from "hono";

import { authRouter } from "./auth/routes";
import { platformRouter } from "./platform/routes";
import { getHealthStatus } from "./config";
import { eventSubRouter } from "./eventsub";
import { panelRouter } from "./panel/routes";
import { realtimeRouter } from "./realtime";
import { scheduled } from "./scheduled";
import { serverTimingMiddleware } from "./server-timing";

export { ChannelObject } from "./durable/ChannelObject";

const app = new Hono<{ Bindings: Env }>();

const overlayContentSecurityPolicy = (publicOrigin: string): string => {
  const publicUrl = new URL(publicOrigin);
  const websocketScheme = publicUrl.protocol === "https:" ? "wss:" : "ws:";
  const websocketOrigin = `${websocketScheme}//${publicUrl.host}`;
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `script-src ${publicUrl.origin}`,
    `style-src ${publicUrl.origin} 'unsafe-inline'`,
    `img-src ${publicUrl.origin}`,
    `font-src ${publicUrl.origin}`,
    `connect-src ${publicUrl.origin} ${websocketOrigin}`,
  ].join("; ");
};

const addOverlayContentSecurityPolicy = (response: Response, publicOrigin: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", overlayContentSecurityPolicy(publicOrigin));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const overlayDocument = async (
  request: Request,
  assets: Env["ASSETS"],
  publicOrigin: string,
): Promise<Response> => {
  const response = await assets.fetch(request);
  return addOverlayContentSecurityPolicy(response, publicOrigin);
};

const isTokenAuthenticatedOverlayApi = (pathname: string): boolean =>
  pathname === "/api/overlay/bootstrap" || /^\/api\/overlay\/variables\/[^/]+$/u.test(pathname);

const addWildcardCors = (response: Response, extraHeaders?: HeadersInit): Response => {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  if (extraHeaders !== undefined) {
    new Headers(extraHeaders).forEach((value, name) => {
      headers.set(name, value);
    });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const overlayApiPreflight = (): Response => addWildcardCors(
  new Response(null, { status: 204 }),
  {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Max-Age": "600",
  },
);

app.use("/api/*", serverTimingMiddleware);
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
app.all("/api/*", (context) => context.json({ error: "unknown_api_route" }, 404));

app.get("/overlay", (context) => overlayDocument(
  context.req.raw,
  context.env.ASSETS,
  context.env.PUBLIC_ORIGIN,
));
app.get("/overlay.html", (context) => overlayDocument(
  context.req.raw,
  context.env.ASSETS,
  context.env.PUBLIC_ORIGIN,
));

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export default {
  fetch: async (request, env, executionContext) => {
    const pathname = new URL(request.url).pathname;
    const overlayApi = isTokenAuthenticatedOverlayApi(pathname);
    if (overlayApi && request.method === "OPTIONS") return overlayApiPreflight();

    const response = await app.fetch(request, env, executionContext);
    return overlayApi ? addWildcardCors(response) : response;
  },
  scheduled,
} satisfies ExportedHandler<Env>;
