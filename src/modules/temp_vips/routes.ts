import { Hono, type Context } from "hono";

import { hasRequiredChannelRole } from "../../contracts/values";
import { DEFAULT_CHANNEL_TIME_ZONE, type ModuleRouteEnvironment, type ModuleTempVipPerson } from "../contract";
import { TEMP_VIP_MINIMUM_DURATION_MS } from "./domain";
import { channelDateTimeToEpoch } from "./domain/time-zone";
import { tempVipsSettingsSchema } from "./contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const HELIX_USERS_URL = "https://api.twitch.tv/helix/users";

type RequestBody = Record<string, unknown>;

const readBody = async (request: Request): Promise<RequestBody | null> => {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as RequestBody
      : null;
  } catch {
    return null;
  }
};

const operationIdFrom = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 200 && /^[\w:.-]+$/u.test(value) ? value : null;

const durationFrom = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= TEMP_VIP_MINIMUM_DURATION_MS ? Number(value) : null;

const operatorDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "temp_vips_operator_required" }, 403);

const isOperator = (role: Parameters<typeof hasRequiredChannelRole>[0]): boolean =>
  hasRequiredChannelRole(role, "operator");

export const tempVipsRoutes = new Hono<ModuleRouteEnvironment>();

type RouteContext = Context<ModuleRouteEnvironment>;

const routeParam = (context: RouteContext, name: string): string => context.req.param(name) as string;

const settingsFor = async (context: RouteContext) => {
  const stored = await context.env.DB.prepare(
    "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'temp_vips'",
  ).bind(routeParam(context, "channelId")).first<{ settings: string }>();
  if (stored === null) return null;
  try {
    const parsed = tempVipsSettingsSchema.safeParse(JSON.parse(stored.settings) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const timeZoneFor = async (context: RouteContext): Promise<string> => {
  const channel = await context.env.DB.prepare(
    "SELECT time_zone FROM channels WHERE channel_id = ?",
  ).bind(routeParam(context, "channelId")).first<{ time_zone: string }>();
  return channel?.time_zone ?? DEFAULT_CHANNEL_TIME_ZONE;
};

const actorFor = (context: RouteContext) => {
  const session = context.get("session");
  return { userId: session.userId, login: session.login ?? session.userId };
};

const resolvePerson = async (context: RouteContext, value: unknown): Promise<
  | { kind: "found"; person: ModuleTempVipPerson }
  | { kind: "missing" }
  | { kind: "unavailable" }
> => {
  if (typeof value !== "string") return { kind: "missing" };
  const login = value.trim().replace(/^@/u, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/u.test(login)) return { kind: "missing" };
  try {
    const accessToken = await context.get("measureServerTiming")("helix", () =>
      context.get("getAppAccessToken")(context.env, new Date().toISOString()));
    const result = await context.get("measureServerTiming")("helix", () => context.get("helixRequest")<{ data?: unknown }>({
      url: HELIX_USERS_URL,
      query: { login },
      accessToken,
      clientId: context.env.TWITCH_CLIENT_ID,
    }));
    if (!result.ok || !Array.isArray(result.data.data)) return { kind: "unavailable" };
    const first: unknown = result.data.data[0];
    if (first === undefined) return { kind: "missing" };
    if (typeof first !== "object" || first === null ||
        typeof Reflect.get(first, "id") !== "string" || typeof Reflect.get(first, "login") !== "string" ||
        typeof Reflect.get(first, "display_name") !== "string") return { kind: "unavailable" };
    return {
      kind: "found",
      person: {
        userId: Reflect.get(first, "id") as string,
        login: Reflect.get(first, "login") as string,
        displayName: Reflect.get(first, "display_name") as string,
      },
    };
  } catch {
    return { kind: "unavailable" };
  }
};

const actionRequest = async (context: RouteContext): Promise<
  | { operationId: string; body: RequestBody }
  | null
> => {
  const body = await readBody(context.req.raw);
  if (body === null) return null;
  const operationId = operationIdFrom(body.operationId);
  return operationId === null ? null : { operationId, body };
};

tempVipsRoutes.get("/vips", async (context) => {
  const channelId = routeParam(context, "channelId");
  const [rows, settings, timeZone] = await Promise.all([
    context.get("tempVips")(channelId).list(),
    settingsFor(context),
    timeZoneFor(context),
  ]);
  if (settings === null) return context.json({ error: "temp_vips_settings_unavailable" }, 500);
  rows.sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt) || left.login.localeCompare(right.login));
  return context.json({ rows, settings, timeZone, now: new Date().toISOString() });
});

tempVipsRoutes.get("/existing-vips", async (context) => {
  if (!isOperator(context.get("channelRole"))) return operatorDenied(context);
  const result = await context.get("tempVips")(routeParam(context, "channelId")).listExisting();
  if (!result.ok) return context.json({ error: "temp_vips_twitch_unavailable", reason: result.reason }, 502);
  return context.json({ people: result.people });
});

tempVipsRoutes.post("/vips/grant", async (context) => {
  if (!isOperator(context.get("channelRole"))) return operatorDenied(context);
  const request = await actionRequest(context);
  if (request === null) return context.json({ error: "temp_vips_request_invalid" }, 400);
  const settings = await settingsFor(context);
  if (settings === null) return context.json({ error: "temp_vips_settings_unavailable" }, 500);
  const durationMs = request.body.durationMs === undefined
    ? settings.defaultDurationDays * DAY_MS
    : durationFrom(request.body.durationMs);
  if (durationMs === null) return context.json({ error: "temp_vips_duration_invalid" }, 400);
  const person = await resolvePerson(context, request.body.login);
  if (person.kind === "missing") return context.json({ error: "temp_vips_user_not_found" }, 404);
  if (person.kind === "unavailable") return context.json({ error: "temp_vips_twitch_unavailable" }, 502);
  const result = await context.get("tempVips")(routeParam(context, "channelId")).grant({
    operationId: request.operationId,
    person: person.person,
    grantedBy: actorFor(context),
    durationMs,
    maximumRemainingMs: settings.maximumDurationDays * DAY_MS,
    source: "dashboard",
  });
  return context.json(result);
});

tempVipsRoutes.post("/vips/import", async (context) => {
  if (!isOperator(context.get("channelRole"))) return operatorDenied(context);
  const request = await actionRequest(context);
  if (request === null || typeof request.body.userId !== "string" || request.body.userId.length === 0) {
    return context.json({ error: "temp_vips_request_invalid" }, 400);
  }
  const [settings, timeZone] = await Promise.all([settingsFor(context), timeZoneFor(context)]);
  if (settings === null) return context.json({ error: "temp_vips_settings_unavailable" }, 500);
  let durationMs: number | null;
  let expiresAt: string | undefined;
  let expiresAtValidatedAt: string | undefined;
  const access = context.get("tempVips")(routeParam(context, "channelId"));
  if (request.body.expiresAtLocal !== undefined) {
    if (typeof request.body.expiresAtLocal !== "string" || request.body.durationMs !== undefined) {
      return context.json({ error: "temp_vips_expiry_invalid" }, 400);
    }
    const now = Date.now();
    const expiry = channelDateTimeToEpoch(request.body.expiresAtLocal, timeZone);
    if (expiry === null) return context.json({ error: "temp_vips_expiry_invalid" }, 400);
    expiresAt = new Date(expiry).toISOString();
    try {
      const replay = await access.replayImport(request.operationId, request.body.userId, expiresAt);
      if (replay !== null) return context.json(replay);
    } catch (error) {
      if (error instanceof Error && error.message === "operation_conflict") {
        return context.json({ error: "temp_vips_operation_conflict" }, 409);
      }
      throw error;
    }
    durationMs = expiry - now;
    if (durationMs < TEMP_VIP_MINIMUM_DURATION_MS) return context.json({ error: "temp_vips_duration_invalid" }, 400);
    if (durationMs > settings.maximumDurationDays * DAY_MS) return context.json({ error: "temp_vips_maximum_exceeded" }, 400);
    expiresAtValidatedAt = new Date(now).toISOString();
  } else {
    durationMs = durationFrom(request.body.durationMs);
    if (durationMs === null) return context.json({ error: "temp_vips_duration_invalid" }, 400);
  }
  const existing = await context.get("tempVips")(routeParam(context, "channelId")).listExisting();
  if (!existing.ok) return context.json({ error: "temp_vips_twitch_unavailable", reason: existing.reason }, 502);
  const person = existing.people.find(({ userId }) => userId === request.body.userId);
  if (person === undefined) return context.json({ status: "not_vip" });
  const result = await access.importExisting({
    operationId: request.operationId,
    person,
    grantedBy: actorFor(context),
    durationMs,
    ...(expiresAt === undefined || expiresAtValidatedAt === undefined ? {} : { expiresAt, expiresAtValidatedAt }),
    maximumRemainingMs: settings.maximumDurationDays * DAY_MS,
    source: "import",
  });
  return context.json(result);
});

tempVipsRoutes.post("/vips/:userId/extend", async (context) => {
  if (!isOperator(context.get("channelRole"))) return operatorDenied(context);
  const request = await actionRequest(context);
  const durationMs = request === null ? null : durationFrom(request.body.durationMs);
  if (request === null) return context.json({ error: "temp_vips_request_invalid" }, 400);
  if (durationMs === null) return context.json({ error: "temp_vips_duration_invalid" }, 400);
  const channelId = routeParam(context, "channelId");
  const [settings, rows] = await Promise.all([settingsFor(context), context.get("tempVips")(channelId).list()]);
  if (settings === null) return context.json({ error: "temp_vips_settings_unavailable" }, 500);
  const row = rows.find(({ userId }) => userId === routeParam(context, "userId"));
  if (row === undefined) return context.json({ status: "not_managed" });
  const result = await context.get("tempVips")(channelId).extend({
    operationId: request.operationId,
    person: { userId: row.userId, login: row.login, displayName: row.displayName },
    grantedBy: actorFor(context),
    durationMs,
    maximumRemainingMs: settings.maximumDurationDays * DAY_MS,
    source: "dashboard",
  });
  return context.json(result);
});

const operationFor = async (
  context: RouteContext,
  action: "end" | "release",
): Promise<Response> => {
  if (!isOperator(context.get("channelRole"))) return operatorDenied(context);
  const request = await actionRequest(context);
  if (request === null) return context.json({ error: "temp_vips_request_invalid" }, 400);
  const access = context.get("tempVips")(routeParam(context, "channelId"));
  const userId = routeParam(context, "userId");
  const operation = { operationId: request.operationId, userId };
  const result = action === "release" ? await access.release(operation) : await access.end(operation);
  return context.json(result);
};

tempVipsRoutes.post("/vips/:userId/end", (context) => operationFor(context, "end"));
tempVipsRoutes.post("/vips/:userId/release", (context) => operationFor(context, "release"));
tempVipsRoutes.post("/vips/:userId/retry", async (context) => {
  if (!isOperator(context.get("channelRole"))) return operatorDenied(context);
  const result = await context.get("tempVips")(routeParam(context, "channelId")).retryRemovalNow(routeParam(context, "userId"));
  return context.json(result);
});

