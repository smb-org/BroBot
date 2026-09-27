import { Hono, type Context } from "hono";

import {
  decryptStoredToken,
  fetchChannelStatus,
  TwitchApiError,
} from "../bot-maintenance";
import { getTokenEncryptionKeys } from "../auth/crypto";
import { getPlatformUserIds } from "../config";
import { canConnectBot } from "../auth/bot-authorization";
import {
  requireChannelAuthorization,
  requireSessionAuthorization,
  type ChannelAuthorizationVariables,
} from "../auth/guards";
import {
  getBotChannelStatusCheckLock,
  getBotChannelStatusCheckedAt,
  releaseBotChannelStatusCheck,
  setBotChannelStatusAndLock,
  tryReserveBotChannelStatusCheck,
} from "../db/bot-channel-status";
import {
  getBotIdentity,
  getBotIdentityStatus,
} from "../db/bot-identity";
import {
  decodeLogCursor,
  getAuditLogForChannel,
  getChannelOverviewForUser,
  getEventLogForChannel,
  getSystemOverviewForUser,
  listChannelsForUser,
  type AuditQueryFilters,
  type LogCursor,
} from "./repository";
import { escapeLoginLikeTerm, hasLoginIdentityMatchingPattern } from "../db/login-identity";
import { memberRouter } from "./member-routes";
import { fetchTwitchUsersById } from "../twitch/user-resolution";
import { moduleRouter } from "./module-routes";
import { variableRouter } from "./variable-routes";
import { overlayRouter } from "./overlay-routes";
import { overlayAccessRouter } from "./overlay-access-routes";
import { channelLocationRouter } from "./channel-location-routes";
import { EVENT_TONES, MANAGING_ROLES, canManage, type EventCode, type EventTone } from "../../contracts/values";
import { auditSubjectUserId, isAuditArea } from "../../dashboard/audit/areas";
import { apiErrorDetail } from "../../modules/contract";
import type { PanelAuditFilters, PanelEventFilters, PanelEventOrigin } from "../../panel-contract";
import { createClip, type CreateClipResult } from "../clip";
import { fetchTwitchUserByLogin, sendShoutout, type ShoutoutSendResult } from "../shoutout";
import { writeModuleAudit } from "../module-audit";
import { publishOverlayHostEvent } from "../realtime";
import { writeModuleDiagnostics } from "../event-log";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { isChannelControlInput, setChannelControl, type ChannelControlKind } from "../db/channel-controls";
import { actorGuard, bindActorGuard } from "../db/guards";
import { prepareAudit } from "../db/audit";
import { HELIX_STREAM_STATE_TTL_MS, lookupAndRefreshStreamState } from "../stream-state-lookup";
import { TWITCH_RATE_LIMIT_COOLDOWN_MS } from "../twitch/rate-limit";
import { getChannelModuleForChannel } from "../db/channel-modules";
import { measureServerTiming, scheduleBackgroundWork } from "../server-timing";
import { DEFAULT_CHANNEL_TIME_ZONE, validChannelTimeZone } from "../../modules/contract";

interface PanelEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;
const MODERATOR_STATUS_CHECK_COOLDOWN_MS = 5 * 60 * 1000;

const parseAuditLimit = (value: string | undefined): number | null => {
  if (value === undefined) return DEFAULT_AUDIT_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_AUDIT_LIMIT ? limit : null;
};

interface LogQuery {
  limit: number;
  cursor: LogCursor | null;
}

const parseEventFilters = (
  context: Context<PanelEnvironment>,
): PanelEventFilters | Response => {
  const origin = context.req.query("origin");
  const tones = [...new Set(new URL(context.req.url).searchParams.getAll("tone"))];
  const moduleId = context.req.query("module");
  const actor = context.req.query("actor");
  if (origin !== undefined && origin !== "channel" && origin !== "module") return context.json({ error: "event_origin_invalid" }, 400);
  if (tones.some((tone) => !EVENT_TONES.includes(tone as EventTone))) return context.json({ error: "event_tone_invalid" }, 400);
  const validOrigin: PanelEventOrigin | null = origin === "channel" || origin === "module" ? origin : null;
  const validTones = tones as EventTone[];
  const validTone: EventTone | null = validTones.length === 1 ? validTones[0] ?? null : null;
  const module = moduleId === undefined || moduleId.length === 0 ? null : moduleId;
  const person = actor === undefined || actor.length === 0 ? null : actor;
  return {
    origin: validOrigin,
    module,
    tone: validTone,
    ...(validTones.length > 1 ? { tones: validTones } : {}),
    person,
  };
};

const parseAuditFilters = (
  context: Context<PanelEnvironment>,
): PanelAuditFilters | Response => {
  const area = context.req.query("area");
  if (area !== undefined && !isAuditArea(area)) return context.json({ error: "audit_area_invalid" }, 400);
  const actor = context.req.query("actor");
  return {
    person: actor === undefined || actor.length === 0 ? null : actor,
    area: area === undefined ? null : area,
  };
};

const isTwitchUserId = (value: string): boolean => /^\d+$/.test(value);

/**
 * The "Person" filter's raw id requirement made it unusable from a search
 * box -- a Twitch user id is never what's displayed (#181 review). A value
 * that isn't already numeric is treated as a login (an optional leading "@"
 * is stripped, matching how a login is shown elsewhere in the dashboard) and
 * matched as a partial, case-insensitive login search against the locally
 * known audit actors (members and platform admins who logged in at least
 * once, in `twitch_login_identity`) -- so e.g. "member" finds "member_c"
 * (#250).
 *
 * A local partial match is combined with, not a substitute for, the exact
 * Twitch lookup of the same term: a search for "bob" must also find an actor
 * who only ever acted under that exact login and has no identity row at
 * all, even though some unrelated "bobby" identity happens to match the
 * partial pattern (review finding, #255). Both are resolved and OR'd
 * together; the Twitch lookup only runs for non-numeric input. If Twitch
 * fails but a local match exists, that local match still wins over a hard
 * failure; a confirmed empty result on both sides means "no such person".
 */
type AuditPersonFilterResolution =
  | { kind: "resolved"; filters: AuditQueryFilters }
  | { kind: "missing" }
  | { kind: "failed" };

const resolveAuditPersonFilter = async (
  environment: Env,
  filters: PanelAuditFilters,
  channelId: string,
): Promise<AuditPersonFilterResolution> => {
  if (filters.person === null) return { kind: "resolved", filters: { area: filters.area, person: null } };
  if (isTwitchUserId(filters.person)) {
    return { kind: "resolved", filters: { area: filters.area, person: { kind: "id", userId: filters.person } } };
  }
  const term = filters.person.replace(/^@/u, "").trim().toLowerCase();
  // "@" alone (or only whitespace/"@") normalizes to "" -- a "%%" pattern
  // would match every login and return the unfiltered log, so an empty term
  // is treated like no person filter at all (#250).
  if (term.length === 0) return { kind: "resolved", filters: { area: filters.area, person: null } };
  const likePattern = `%${escapeLoginLikeTerm(term)}%`;
  const hasLocalMatch = await hasLoginIdentityMatchingPattern(environment.DB, likePattern, channelId);
  let exactUserId: string | null;
  try {
    const user = await fetchTwitchUserByLogin(fetch, environment, term, "app");
    exactUserId = user?.userId ?? null;
  } catch {
    // Twitch is down: a local match still answers the query; only a
    // completely empty result needs to surface as an error (#255).
    return hasLocalMatch
      ? { kind: "resolved", filters: { area: filters.area, person: { kind: "loginLike", pattern: likePattern } } }
      : { kind: "failed" };
  }
  if (hasLocalMatch && exactUserId !== null) {
    return {
      kind: "resolved",
      filters: { area: filters.area, person: { kind: "loginLikeOrId", pattern: likePattern, userId: exactUserId } },
    };
  }
  if (hasLocalMatch) {
    return { kind: "resolved", filters: { area: filters.area, person: { kind: "loginLike", pattern: likePattern } } };
  }
  return exactUserId === null
    ? { kind: "missing" }
    : { kind: "resolved", filters: { area: filters.area, person: { kind: "id", userId: exactUserId } } };
};

// Only shares the parsing/error mechanics between the audit log and the
// event log. Both logs deliberately have different read permissions and
// retention periods (see docs/decisions/0004-ereignisprotokoll.md) — that
// stays per route; this helper doesn't merge them in substance.
const parseLogQuery = (
  context: Context<PanelEnvironment>,
): LogQuery | Response => {
  const limit = parseAuditLimit(context.req.query("limit"));
  if (limit === null) return context.json({ error: "pagination_limit_invalid" }, 400);
  const serializedCursor = context.req.query("cursor");
  const cursor = serializedCursor === undefined ? null : decodeLogCursor(serializedCursor);
  if (serializedCursor !== undefined && cursor === null) return context.json({ error: "pagination_cursor_invalid" }, 400);
  return { limit, cursor };
};

const nowIso = (): string => new Date().toISOString();

const laterIso = (now: string, milliseconds: number): string =>
  new Date(Date.parse(now) + milliseconds).toISOString();

const canCheckModeratorStatus = canManage;

const readBotCredentials = async (environment: Env): Promise<{ userId: string; accessToken: string } | null> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return null;
  const accessToken = await decryptStoredToken(identity.accessTokenCiphertext, getTokenEncryptionKeys(environment));
  return accessToken === null ? null : { userId: identity.userId, accessToken };
};

const clipStatusFor = (reason: string | null): 400 | 401 | 429 | 502 | 503 => {
  if (reason === "not_live") return 400;
  if (reason === "scope_missing" || reason === "bot_identity_missing") return 401;
  if (reason === "rate_limited") return 429;
  if (reason === "network_error") return 503;
  return 502;
};

const isChannelControlKind = (value: string): value is ChannelControlKind =>
  value === "mute" || value === "pause";

export const panelRouter = new Hono<PanelEnvironment>();

panelRouter.route("/", memberRouter);
panelRouter.route("/", moduleRouter);
panelRouter.route("/", variableRouter);
panelRouter.route("/", overlayRouter);
panelRouter.route("/", overlayAccessRouter);
panelRouter.route("/", channelLocationRouter);

panelRouter.get("/api/channels/:channelId/settings", requireChannelAuthorization(), async (context) => {
  const row = await context.env.DB.prepare(
    `SELECT time_zone, time_zone_revision, location_name, location_latitude, location_longitude,
            location_time_zone, location_revision
       FROM channels WHERE channel_id = ?`,
  ).bind(context.req.param("channelId")).first<{
    time_zone: string;
    time_zone_revision: number;
    location_name: string | null;
    location_latitude: number | null;
    location_longitude: number | null;
    location_time_zone: string | null;
    location_revision: number;
  }>();
  if (row === null) return context.json({ error: "channel_not_found" }, 404);
  const location = row.location_name !== null && row.location_latitude !== null && row.location_longitude !== null && row.location_time_zone !== null
    ? { name: row.location_name, latitude: row.location_latitude, longitude: row.location_longitude, timeZone: row.location_time_zone }
    : null;
  return context.json({
    timeZone: row.time_zone,
    revision: row.time_zone_revision,
    location,
    locationRevision: row.location_revision,
  });
});

panelRouter.patch("/api/channels/:channelId/settings", requireChannelAuthorization(), async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "channel_settings_denied" }, 403);
  const body: unknown = await context.req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return context.json({ error: "channel_settings_invalid" }, 400);
  }
  const timeZone: unknown = Reflect.get(body, "timeZone");
  const revision: unknown = Reflect.get(body, "revision");
  if (typeof timeZone !== "string" || timeZone.length > 80 || !validChannelTimeZone(timeZone) ||
      !Number.isSafeInteger(revision) || (revision as number) < 1) {
    return context.json({ error: "channel_time_zone_invalid" }, 400);
  }
  const channelId = context.req.param("channelId");
  const previous = await context.env.DB.prepare(
    "SELECT time_zone FROM channels WHERE channel_id = ? AND time_zone_revision = ?",
  ).bind(channelId, revision).first<{ time_zone: string }>();
  if (previous === null) return context.json({ error: "channel_settings_conflict" }, 409);
  const changedAt = nowIso();
  const nextRevision = (revision as number) + 1;
  const mutation = context.env.DB.prepare(
    `UPDATE channels SET time_zone = ?, time_zone_revision = ?, updated_at = ?
      WHERE channel_id = ? AND time_zone_revision = ? ${actorGuard(MANAGING_ROLES)}`,
  ).bind(timeZone, nextRevision, changedAt, channelId, revision,
    ...bindActorGuard(context.get("actor"), channelId, changedAt));
  const audit = prepareAudit(context.env.DB, context.get("actor").userId, changedAt, channelId, null,
    "channel.time_zone.updated", { timeZone: previous.time_zone }, { timeZone });
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) return context.json({ error: "channel_settings_conflict" }, 409);
  await publishOverlayHostEvent(context.env.CHANNEL, context.env.DB, channelId, "template.data.changed");
  return context.json({ ok: true, timeZone, revision: nextRevision, defaultTimeZone: DEFAULT_CHANNEL_TIME_ZONE });
});

panelRouter.post(
  "/api/channels/:channelId/controls/:control",
  requireChannelAuthorization(),
  async (context) => {
    const control = context.req.param("control");
    if (!isChannelControlKind(control)) return context.json({ error: "channel_control_input_invalid" }, 400);
    const body: unknown = await context.req.json().catch(() => null);
    const duration = body !== null && typeof body === "object" && !Array.isArray(body) && "duration" in body
      ? body.duration
      : undefined;
    if (!isChannelControlInput(duration)) return context.json({ error: "channel_control_input_invalid" }, 400);

    const changedAt = nowIso();
    const result = await setChannelControl(
      context.env.DB,
      context.get("actor"),
      context.req.param("channelId"),
      control,
      duration,
      changedAt,
    );
    if (result.outcome === "concurrent") {
      return context.json({ error: "channel_control_changed_concurrently" }, 409);
    }
    return context.json({ controls: result.controls });
  },
);

panelRouter.get("/api/channels", requireSessionAuthorization(), async (context) => {
  const session = context.get("session");
  const [channels, bot, botIdentity] = await measureServerTiming(context, "d1", () => Promise.all([
    listChannelsForUser(context.env.DB, session.userId),
    getBotIdentityStatus(context.env.DB),
    getBotIdentity(context.env.DB),
  ]));
  const platformAdmin = getPlatformUserIds(context.env).has(session.userId);
  const viewerIsBot = canConnectBot(session, context.env, botIdentity);
  return context.json({
    channels,
    // The installation's single bot identity (`bot_identity_status`, id=1),
    // independent of which channels this viewer can see -- a fresh
    // installation with zero released channels still needs to tell a
    // platform admin the bot isn't signed in (#159).
    bot,
    platformAdmin,
    viewerIsBot,
    ...((platformAdmin || viewerIsBot) ? { botLogin: context.env.TWITCH_BOT_LOGIN } : {}),
  });
});

panelRouter.get(
  "/api/channels/:channelId/overview",
  requireChannelAuthorization(),
  async (context) => {
    const session = context.get("session");
    const channelId = context.req.param("channelId");
    const checkedAt = nowIso();
    const overview = await measureServerTiming(context, "d1", () => getChannelOverviewForUser(context.env.DB, session.userId, channelId));
    if (overview === null) return context.json({ error: "channel_not_found" }, 404);
    const channelNamespace = Reflect.get(context.env, "CHANNEL") as Env["CHANNEL"] | undefined;
    const observedAt = overview.streamStateCheckedAt === undefined || overview.streamStateCheckedAt === null
      ? Number.NaN
      : Date.parse(overview.streamStateCheckedAt);
    const streamStateIsStale = !Number.isFinite(observedAt) || Date.parse(checkedAt) - observedAt >= HELIX_STREAM_STATE_TTL_MS;
    if (channelNamespace !== undefined && streamStateIsStale) {
      const object = channelNamespace.get(channelNamespace.idFromName(channelId));
      scheduleBackgroundWork(context, (async () => {
        if (await object.getTwitchRateLimitRetryAfter() !== null) return;
        const lease = await object.beginStreamStateRefresh();
        if (lease === null) return;
        try {
          const result = await lookupAndRefreshStreamState(context.env, channelId, checkedAt);
          if (result.rateLimited) {
            await object.setTwitchRateLimitRetryAfter(Date.now() + TWITCH_RATE_LIMIT_COOLDOWN_MS);
            console.warn("Background stream-state refresh was rate-limited.", channelId);
          }
        } catch (error: unknown) {
          console.warn("Background stream-state refresh failed.", channelId, error);
        } finally {
          await object.endStreamStateRefresh(lease);
        }
      })());
    }
    return context.json(overview);
  },
);

panelRouter.post(
  "/api/channels/:channelId/moderator-status",
  requireChannelAuthorization(),
  async (context) => {
    if (!canCheckModeratorStatus(context.get("channelRole"))) {
      return context.json({ error: "moderator_status_check_denied" }, 403);
    }

    const channelId = context.req.param("channelId");
    const checkedAt = nowIso();
    const checkedSince = laterIso(checkedAt, -MODERATOR_STATUS_CHECK_COOLDOWN_MS);
    const nextAllowedAt = laterIso(checkedAt, MODERATOR_STATUS_CHECK_COOLDOWN_MS);
    const ownerId = await tryReserveBotChannelStatusCheck(
      context.env.DB,
      channelId,
      nextAllowedAt,
      checkedAt,
      checkedSince,
    );
    if (ownerId === null) {
      const lockedUntil = await getBotChannelStatusCheckLock(context.env.DB, channelId);
      const lastCheckedAt = await getBotChannelStatusCheckedAt(context.env.DB, channelId);
      const statusRetryAt = lastCheckedAt === null
        ? null
        : laterIso(lastCheckedAt, MODERATOR_STATUS_CHECK_COOLDOWN_MS);
      const retryAt = lockedUntil ?? statusRetryAt ?? nextAllowedAt;
      return context.json({
        error: "moderator_status_check_rate_limited",
        nextAllowedAt: retryAt,
      }, 429);
    }

    let statusFetched = false;
    try {
      const credentials = await readBotCredentials(context.env);
      if (credentials === null) {
        throw new Error("Bot token missing or could not be read.");
      }
      const isModerator = await fetchChannelStatus(
        fetch,
        context.env.TWITCH_CLIENT_ID,
        credentials.userId,
        credentials.accessToken,
        channelId,
      );
      statusFetched = true;
      await setBotChannelStatusAndLock(
        context.env.DB,
        channelId,
        ownerId,
        isModerator,
        checkedAt,
        null,
        nextAllowedAt,
      );
      try {
        await maintainEventSubSubscriptions(context.env, checkedAt, fetch, channelId);
      } catch {
        // The successful moderator check remains successful if maintenance fails.
      }
      return context.json({
        moderator: { isModerator, checkedAt, reason: null },
        nextAllowedAt,
      });
    } catch (error: unknown) {
      if (!statusFetched) {
        try {
          await releaseBotChannelStatusCheck(context.env.DB, channelId, ownerId);
        } catch {
          // The Twitch-side cause matters more to the user than a failed cleanup.
        }
      }
      const status = error instanceof TwitchApiError && error.status === 504 ? 504
        : error instanceof TwitchApiError ? 502
        : 503;
      return context.json({ error: "moderator_status_check_failed" }, status);
    }
  },
);

/**
 * Immediate action, open to any channel member (0006's "Betrieblich" tier,
 * same reasoning as ads commercial/snooze): creating a clip doesn't
 * reconfigure the channel. Host-level, not a module route -- the bot's own
 * identity already carries `clips:edit`, no broadcaster consent needed.
 */
panelRouter.post(
  "/api/channels/:channelId/clips",
  requireChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    const clipsModule = await getChannelModuleForChannel(context.env.DB, channelId, "clips");
    if (clipsModule === null) return context.json({ error: "module_not_configured" }, 404);
    if (!clipsModule.enabled) return context.json({ error: "module_disabled" }, 409);
    const triggerId = `clip:${crypto.randomUUID()}`;
    const now = nowIso();
    const credentials = await readBotCredentials(context.env);
    const result: CreateClipResult = credentials === null
      ? { created: false, reason: "bot_identity_missing", detail: {}, clipId: null, editUrl: null }
      : await createClip(context.env, credentials.accessToken, channelId, fetch);

    if (!result.created) {
      await writeModuleDiagnostics(context.env.DB, channelId, "host", triggerId, context.get("actor").userId, [
        { code: "host.clip.failed" satisfies EventCode, detail: { reason: result.reason, ...result.detail } },
      ], now);
      return context.json({
        error: result.reason === "not_live" ? "clip_stream_offline" : "clip_create_failed",
        reason: result.reason,
        detail: apiErrorDetail(result.detail),
      }, clipStatusFor(result.reason));
    }

    await writeModuleAudit(context.env.DB, context.get("actor").userId, now, {
      channelId,
      moduleId: null,
      action: "clip.created",
      before: null,
      after: { clipId: result.clipId },
    });

    return context.json({ clipId: result.clipId, editUrl: result.editUrl });
  },
);

const isShoutoutLogin = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0 && value.trim().length <= 25 && !/\s/.test(value.trim());

const shoutoutStatusFor = (reason: ShoutoutSendResult["reason"]): 400 | 403 | 404 | 429 | 502 | 503 => {
  if (reason === "rate_limited") return 429;
  if (reason === "network_error" || reason === "app_token_unavailable" || reason === "bot_identity_missing") return 503;
  if (reason === "not_moderator" || reason === "scope_missing") return 403;
  if (reason === "twitch_user_not_found") return 404;
  return 502;
};

/**
 * Immediate action, open to any channel member (0006's "Betrieblich" tier,
 * same reasoning as commercial/clip above). Host-level: it resolves a login
 * to a Twitch user id, then reuses the same `sendShoutout` the raid module
 * triggers automatically.
 */
panelRouter.post(
  "/api/channels/:channelId/shoutout",
  requireChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    const raidModule = await getChannelModuleForChannel(context.env.DB, channelId, "raid");
    if (raidModule === null) return context.json({ error: "module_not_configured" }, 404);
    if (!raidModule.enabled) return context.json({ error: "module_disabled" }, 409);
    const triggerId = `shoutout:${crypto.randomUUID()}`;
    const now = nowIso();
    const body: unknown = await context.req.json().catch(() => null);
    const login = body !== null && typeof body === "object" && "login" in body && typeof body.login === "string"
      ? body.login
      : undefined;
    if (!isShoutoutLogin(login)) return context.json({ error: "twitch_login_invalid" }, 400);

    let targetUserId: string;
    try {
      const user = await fetchTwitchUserByLogin(fetch, context.env, login.trim());
      if (user === null) return context.json({ error: "twitch_user_not_found" }, 404);
      targetUserId = user.userId;
    } catch {
      return context.json({ error: "twitch_user_search_failed" }, 502);
    }

    const result = await sendShoutout(context.env, channelId, targetUserId, fetch);
    await writeModuleDiagnostics(context.env.DB, channelId, "host", triggerId, context.get("actor").userId, [
      result.sent
        ? { code: "host.shoutout.sent" satisfies EventCode, detail: result.detail }
        : { code: "host.shoutout.failed" satisfies EventCode, detail: { cause: result.reason, ...result.detail } },
    ], now);

    if (!result.sent) {
      return context.json({ error: "shoutout_send_failed", reason: result.reason, detail: apiErrorDetail(result.detail) }, shoutoutStatusFor(result.reason));
    }
    return context.json({ sent: true });
  },
);

panelRouter.get(
  "/api/channels/:channelId/system",
  requireChannelAuthorization(),
  async (context) => {
    const session = context.get("session");
    const channelId = context.req.param("channelId");
    const overview = await measureServerTiming(context, "d1", () => getSystemOverviewForUser(context.env.DB, session.userId, channelId));
    return overview === null
      ? context.json({ error: "channel_not_found" }, 404)
      : context.json(overview);
  },
);

panelRouter.get(
  "/api/channels/:channelId/audit-log",
  requireChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    const parsed = parseLogQuery(context);
    if (parsed instanceof Response) return parsed;
    const filters = parseAuditFilters(context);
    if (filters instanceof Response) return filters;
    const personResolution = await resolveAuditPersonFilter(context.env, filters, channelId);
    if (personResolution.kind === "missing") return context.json({ entries: [], nextCursor: null });
    if (personResolution.kind === "failed") return context.json({ error: "twitch_user_search_failed" }, 502);
    const audit = await getAuditLogForChannel(context.env.DB, channelId, parsed.limit, parsed.cursor, personResolution.filters);
    // The subject enrichment (#181 item 2/4) reuses the actor lookup's single
    // batched Twitch call -- a member action's target is just another user id
    // living in `before`/`after`, resolved the same way as the actor.
    const subjectIds = audit.entries.flatMap((entry) => {
      const subjectId = auditSubjectUserId(entry.action, entry.before, entry.after);
      return subjectId === null ? [] : [subjectId];
    });
    const userIds = [...new Set([...audit.entries.map((entry) => entry.actorUserId), ...subjectIds])];
    const users = await fetchTwitchUsersById(fetch, context.env, userIds);
    return context.json({
      ...audit,
      entries: audit.entries.map((entry) => {
        const actor = users.get(entry.actorUserId);
        const subjectId = auditSubjectUserId(entry.action, entry.before, entry.after);
        const subject = subjectId === null ? undefined : users.get(subjectId);
        return {
          ...entry,
          actorLogin: actor?.login ?? null,
          actorDisplayName: actor?.displayName ?? null,
          ...(subjectId === null ? {} : { subjectUserId: subjectId, subjectLogin: subject?.login ?? null, subjectDisplayName: subject?.displayName ?? null }),
        };
      }),
    });
  },
);

panelRouter.get(
  "/api/channels/:channelId/events",
  requireChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    const parsed = parseLogQuery(context);
    if (parsed instanceof Response) return parsed;
    const filters = parseEventFilters(context);
    if (filters instanceof Response) return filters;
    const events = await getEventLogForChannel(context.env.DB, channelId, parsed.limit, parsed.cursor, filters);
    const actorIds = events.entries.flatMap((entry) => entry.actorUserId === null ? [] : [entry.actorUserId]);
    const actors = await fetchTwitchUsersById(fetch, context.env, actorIds);
    return context.json({
      ...events,
      entries: events.entries.map((entry) => {
        const actor = entry.actorUserId === null ? undefined : actors.get(entry.actorUserId);
        return {
          ...entry,
          actorLogin: actor?.login ?? null,
          actorDisplayName: actor?.displayName ?? null,
        };
      }),
    });
  },
);
