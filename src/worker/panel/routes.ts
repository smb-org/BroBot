import { Hono } from "hono";

import {
  requireChannelAuthorization,
  requireSessionAuthorization,
  type ChannelAuthorizationVariables,
} from "../auth/guards";
import {
  decodeAuditLogCursor,
  getAuditLogForChannel,
  getChannelOverviewForUser,
  getSystemOverviewForUser,
  listChannelsForUser,
} from "./repository";
import { memberRouter } from "./member-routes";

interface PanelEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 100;

const parseAuditLimit = (value: string | undefined): number | null => {
  if (value === undefined) return DEFAULT_AUDIT_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_AUDIT_LIMIT ? limit : null;
};

export const panelRouter = new Hono<PanelEnvironment>();

panelRouter.route("/", memberRouter);

panelRouter.get("/api/channels", requireSessionAuthorization(), async (context) => {
  const session = context.get("session");
  return context.json({ channels: await listChannelsForUser(context.env.DB, session.userId) });
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
    const limit = parseAuditLimit(context.req.query("limit"));
    if (limit === null) return context.text("Audit-Begrenzung ist ungültig.", 400);
    const serializedCursor = context.req.query("cursor");
    const cursor = serializedCursor === undefined ? null : decodeAuditLogCursor(serializedCursor);
    if (serializedCursor !== undefined && cursor === null) return context.text("Audit-Cursor ist ungültig.", 400);
    return context.json(await getAuditLogForChannel(context.env.DB, channelId, limit, cursor));
  },
);
