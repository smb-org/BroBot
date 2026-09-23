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
  type LogCursor,
} from "./repository";
import { fetchTwitchUsersById, memberRouter } from "./member-routes";
import { moduleRouter } from "./module-routes";
import { EVENT_TONES, canManage, type EventCode, type EventTone } from "../../contracts/values";
import type { PanelEventFilters, PanelEventOrigin } from "../../panel-contract";
import { createClip, type CreateClipResult } from "../clip";
import { fetchTwitchUserByLogin, sendShoutout, type ShoutoutSendResult } from "../shoutout";
import { writeModuleAudit } from "../module-audit";
import { writeModuleDiagnostics } from "../event-log";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { isChannelControlInput, setChannelControl, type ChannelControlKind } from "../db/channel-controls";
import { lookupAndRefreshStreamState } from "../stream-state-lookup";

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
  const [channels, bot, botIdentity] = await Promise.all([
    listChannelsForUser(context.env.DB, session.userId),
    getBotIdentityStatus(context.env.DB),
    getBotIdentity(context.env.DB),
  ]);
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
    const overview = await getChannelOverviewForUser(context.env.DB, session.userId, channelId);
    if (overview === null) return context.json({ error: "channel_not_found" }, 404);
    if (overview.streamState !== null && overview.streamState !== undefined) return context.json(overview);
    const checkedAt = nowIso();
    const looked = await lookupAndRefreshStreamState(context.env, channelId, checkedAt);
    return context.json(looked.state === null ? overview : {
      ...overview,
      streamState: looked.state,
      ...(looked.startedAt === null ? {} : { streamStartedAt: looked.startedAt }),
    });
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
        detail: result.detail,
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
      return context.json({ error: "shoutout_send_failed", reason: result.reason, detail: result.detail }, shoutoutStatusFor(result.reason));
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
    const overview = await getSystemOverviewForUser(context.env.DB, session.userId, channelId);
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
    const audit = await getAuditLogForChannel(context.env.DB, channelId, parsed.limit, parsed.cursor);
    const actorIds = audit.entries.map((entry) => entry.actorUserId);
    const actors = await fetchTwitchUsersById(fetch, context.env, actorIds);
    return context.json({
      ...audit,
      entries: audit.entries.map((entry) => {
        const actor = actors.get(entry.actorUserId);
        return {
          ...entry,
          actorLogin: actor?.login ?? null,
          actorDisplayName: actor?.displayName ?? null,
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
