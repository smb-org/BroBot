import { Hono, type Context } from "hono";

import {
  decryptStoredToken,
  fetchChannelStatus,
  TwitchApiError,
} from "../bot-maintenance";
import { getTokenEncryptionKeys } from "../auth/crypto";
import { getPlatformUserIds } from "../config";
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
import { EVENT_TONES, type EventTone } from "../../contracts/values";
import type { PanelEventFilters, PanelEventOrigin } from "../../panel-contract";

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
  const tone = context.req.query("tone");
  const moduleId = context.req.query("module");
  const actor = context.req.query("actor");
  if (origin !== undefined && origin !== "channel" && origin !== "module") return context.json({ error: "event_origin_invalid" }, 400);
  if (tone !== undefined && !EVENT_TONES.includes(tone as EventTone)) return context.json({ error: "event_tone_invalid" }, 400);
  const validOrigin: PanelEventOrigin | null = origin === "channel" || origin === "module" ? origin : null;
  const validTone: EventTone | null = tone === undefined ? null : tone as EventTone;
  const module = moduleId === undefined || moduleId.length === 0 ? null : moduleId;
  const person = actor === undefined || actor.length === 0 ? null : actor;
  return { origin: validOrigin, module: module, tone: validTone, person };
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

const canCheckModeratorStatus = (role: ChannelAuthorizationVariables["channelRole"]): boolean =>
  role !== "operator";

const readBotCredentials = async (environment: Env): Promise<{ userId: string; accessToken: string } | null> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return null;
  const accessToken = await decryptStoredToken(identity.accessTokenCiphertext, getTokenEncryptionKeys(environment));
  return accessToken === null ? null : { userId: identity.userId, accessToken };
};

export const panelRouter = new Hono<PanelEnvironment>();

panelRouter.route("/", memberRouter);
panelRouter.route("/", moduleRouter);

panelRouter.get("/api/channels", requireSessionAuthorization(), async (context) => {
  const session = context.get("session");
  const [channels, bot] = await Promise.all([
    listChannelsForUser(context.env.DB, session.userId),
    getBotIdentityStatus(context.env.DB),
  ]);
  return context.json({
    channels,
    // The installation's single bot identity (`bot_identity_status`, id=1),
    // independent of which channels this viewer can see -- a fresh
    // installation with zero released channels still needs to tell a
    // platform admin the bot isn't signed in (#159).
    bot,
    platformAdmin: getPlatformUserIds(context.env).has(session.userId),
  });
});

panelRouter.get(
  "/api/channels/:channelId/overview",
  requireChannelAuthorization(),
  async (context) => {
    const session = context.get("session");
    const channelId = context.req.param("channelId");
    const overview = await getChannelOverviewForUser(context.env.DB, session.userId, channelId);
    return overview === null
      ? context.json({ error: "channel_not_found" }, 404)
      : context.json(overview);
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
