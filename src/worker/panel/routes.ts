import { Hono, type Context } from "hono";

import {
  decryptStoredToken,
  fetchModeratedChannelStatus,
  TwitchApiError,
} from "../bot-maintenance";
import { getTokenEncryptionKeys } from "../auth/crypto";
import { getBetreiberUserIds } from "../config";
import {
  requireChannelAuthorization,
  requireSessionAuthorization,
  type ChannelAuthorizationVariables,
} from "../auth/guards";
import {
  getBotChannelStatusCheckLock,
  getBotChannelStatusCheckedAt,
  getBotIdentity,
  releaseBotChannelStatusCheck,
  setBotChannelStatusAndLock,
  tryReserveBotChannelStatusCheck,
} from "../auth/repository";
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

// Teilt sich nur die Parse-/Fehlermechanik zwischen Audit- und Ereignisprotokoll.
// Beide Protokolle haben absichtlich unterschiedliche Leseberechtigungen und
// Aufbewahrungsfristen (siehe docs/decisions/0004-ereignisprotokoll.md) — das bleibt
// pro Route stehen, dieser Helfer fasst sie inhaltlich nicht zusammen.
const parseLogQuery = (
  context: Context<PanelEnvironment>,
  fehlertexte: { limit: string; cursor: string },
): LogQuery | Response => {
  const limit = parseAuditLimit(context.req.query("limit"));
  if (limit === null) return context.text(fehlertexte.limit, 400);
  const serializedCursor = context.req.query("cursor");
  const cursor = serializedCursor === undefined ? null : decodeLogCursor(serializedCursor);
  if (serializedCursor !== undefined && cursor === null) return context.text(fehlertexte.cursor, 400);
  return { limit, cursor };
};

const nowIso = (): string => new Date().toISOString();

const laterIso = (now: string, milliseconds: number): string =>
  new Date(Date.parse(now) + milliseconds).toISOString();

const canCheckModeratorStatus = (role: ChannelAuthorizationVariables["channelRole"]): boolean =>
  role !== "bediener";

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
  return context.json({
    channels: await listChannelsForUser(context.env.DB, session.userId),
    betreiber: getBetreiberUserIds(context.env).has(session.userId),
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
      ? context.text("Kanal nicht gefunden.", 404)
      : context.json(overview);
  },
);

panelRouter.post(
  "/api/channels/:channelId/moderator-status",
  requireChannelAuthorization(),
  async (context) => {
    if (!canCheckModeratorStatus(context.get("channelRole"))) {
      return context.text("Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.", 403);
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
        error: "Der Moderatorstatus wurde für diesen Kanal kürzlich geprüft.",
        nextAllowedAt: retryAt,
      }, 429);
    }

    let statusFetched = false;
    try {
      const credentials = await readBotCredentials(context.env);
      if (credentials === null) {
        throw new Error("Bot-Token fehlt oder konnte nicht gelesen werden.");
      }
      const isModerator = await fetchModeratedChannelStatus(
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
          // Die Twitch-Ursache ist für den Nutzer wichtiger als ein fehlgeschlagenes Aufräumen.
        }
      }
      const message = error instanceof Error ? error.message : "Moderatorstatus konnte nicht gelesen werden.";
      const status = error instanceof TwitchApiError && error.status === 504 ? 504
        : error instanceof TwitchApiError ? 502
        : 503;
      return context.json({ error: message }, status);
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
      ? context.text("Kanal nicht gefunden.", 404)
      : context.json(overview);
  },
);

panelRouter.get(
  "/api/channels/:channelId/audit-log",
  requireChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    const parsed = parseLogQuery(context, {
      limit: "Audit-Begrenzung ist ungültig.",
      cursor: "Audit-Cursor ist ungültig.",
    });
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
    const parsed = parseLogQuery(context, {
      limit: "Ereignis-Begrenzung ist ungültig.",
      cursor: "Ereignis-Cursor ist ungültig.",
    });
    if (parsed instanceof Response) return parsed;
    const events = await getEventLogForChannel(context.env.DB, channelId, parsed.limit, parsed.cursor);
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
