import type { MiddlewareHandler } from "hono";
import { SERVER_TIMING_PHASES } from "../server-timing";

export { measureServerTiming, recordServerTiming, scheduleBackgroundWork } from "../server-timing";

export const serverTimingMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (context, next) => {
  context.set("serverTiming", { auth: 0, d1: 0, do: 0, helix: 0 });
  await next();
  const response = context.res;
  const headers = new Headers(response.headers);
  headers.set("Server-Timing", SERVER_TIMING_PHASES.map((phase) =>
    `${phase};dur=${context.get("serverTiming")[phase].toFixed(1)}`,
  ).join(", "));
  context.res = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
