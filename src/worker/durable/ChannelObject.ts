import { DurableObject } from "cloudflare:workers";

import type {
  RealtimeEnvelope,
  RealtimeMessage,
  RealtimePrincipal,
  RealtimeRecipientKind,
} from "../../realtime-contract";
import { REALTIME_RECIPIENTS } from "../../realtime-contract";
import { CHANNEL_ROLES, type ChannelRole } from "../../contracts/values";
import { processAdPrewarning } from "../ad-prewarning";
import { REALTIME_PRINCIPAL_HEADER, REALTIME_PROTOCOL } from "../realtime-protocol";

const SECURITY_ALARM_INTERVAL_MS = 15 * 60 * 1000;
// On reset, the Durable Object class instance is discarded, so new keys are
// safe. Without this reset, scheduleEarliestAlarm() would not find the old
// deadlines, would silently delete the alarm, and both the security round
// and the ad prewarning would stop firing.
const SECURITY_DEADLINE_KEY = "security_round";
const AD_PREWARNING_DEADLINE_KEY = "ad_prewarning";
const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;

type SessionValidityRow = {
  session_id: string;
  user_id: string;
  role: ChannelRole | null;
};

type TokenValidityRow = { token_id: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isRealtimePrincipal = (value: unknown): value is RealtimePrincipal => {
  if (!isRecord(value) || value.v !== 1 || !isNonEmptyString(value.channelId)) return false;
  if (value.kind === "panel") {
    return isNonEmptyString(value.userId) &&
      isNonEmptyString(value.sessionId) &&
      typeof value.role === "string" && CHANNEL_ROLES.includes(value.role as ChannelRole) &&
      isNonEmptyString(value.expiresAt);
  }
  if (value.kind === "overlay") {
    return isNonEmptyString(value.tokenId) &&
      (value.expiresAt === null || isNonEmptyString(value.expiresAt));
  }
  return false;
};

const readAttachment = (webSocket: WebSocket): RealtimePrincipal | null => {
  try {
    const attachment: unknown = webSocket.deserializeAttachment();
    return isRealtimePrincipal(attachment) ? attachment : null;
  } catch {
    return null;
  }
};

const isExpired = (principal: RealtimePrincipal, now: number): boolean => {
  if (principal.expiresAt === null) return false;
  const expiresAt = Date.parse(principal.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
};

const closeSocket = (webSocket: WebSocket, code: number, reason: string): void => {
  try {
    webSocket.close(code, reason);
  } catch {
    // The socket may already have closed between selection and close.
  }
};

const tagsFor = (principal: RealtimePrincipal): string[] => principal.kind === "panel"
  ? [`kind:${principal.kind}`, `user:${principal.userId}`, `session:${principal.sessionId}`]
  : [`kind:${principal.kind}`, `token:${principal.tokenId}`];

const envelopeFor = (
  channelId: string,
  type: "system.hello",
): RealtimeEnvelope<"system.hello"> => ({
  version: 1,
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  channelId,
  type,
  payload: {},
});

/**
 * Channel-bound realtime room. Hibernation is a hard invariant here: no
 * class field holds state that still needs to be correct after waking up.
 * Principals and tags live on the socket; the only periodic work is in the
 * alarm, and the authorization data lives in D1.
 */
export class ChannelObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private ownChannelId(): string | null {
    const name = this.ctx.id.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  }

  private async scheduleEarliestAlarm(): Promise<void> {
    const deadlines = await Promise.all([
      this.ctx.storage.get(SECURITY_DEADLINE_KEY),
      this.ctx.storage.get(AD_PREWARNING_DEADLINE_KEY),
    ]);
    const validDeadlines = deadlines.filter((deadline): deadline is number =>
      typeof deadline === "number" && Number.isFinite(deadline));
    if (validDeadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...validDeadlines));
  }

  private async scheduleSecurityAlarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.delete(SECURITY_DEADLINE_KEY);
    } else {
      await this.ctx.storage.put(SECURITY_DEADLINE_KEY, Date.now() + SECURITY_ALARM_INTERVAL_MS);
    }
    await this.scheduleEarliestAlarm();
  }

  private async stopSecurityAlarmIfIdle(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.delete(SECURITY_DEADLINE_KEY);
      await this.scheduleEarliestAlarm();
    }
  }

  public async scheduleAdPrewarning(dueAtMs: number): Promise<void> {
    if (!Number.isFinite(dueAtMs)) {
      await this.clearAdPrewarning();
      return;
    }
    await this.ctx.storage.put(AD_PREWARNING_DEADLINE_KEY, dueAtMs);
    await this.scheduleEarliestAlarm();
  }

  public async clearAdPrewarning(): Promise<void> {
    await this.ctx.storage.delete(AD_PREWARNING_DEADLINE_KEY);
    await this.scheduleEarliestAlarm();
  }

  override fetch(request: Request): Response {
    const rawPrincipal = request.headers.get(REALTIME_PRINCIPAL_HEADER);
    let principal: RealtimePrincipal | null = null;
    if (rawPrincipal !== null) {
      try {
        const parsed: unknown = JSON.parse(rawPrincipal);
        principal = isRealtimePrincipal(parsed) ? parsed : null;
      } catch {
        principal = null;
      }
    }

    const ownChannelId = this.ownChannelId();
    if (principal === null || ownChannelId === null || principal.channelId !== ownChannelId) {
      return new Response("Channel access denied.", { status: 403 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    if (request.headers.get("Sec-WebSocket-Protocol") !== REALTIME_PROTOCOL) {
      return new Response("Realtime protocol is not supported.", { status: 426 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], tagsFor(principal));
    pair[1].serializeAttachment(principal);
    void this.scheduleSecurityAlarm();
    pair[1].send(JSON.stringify(envelopeFor(ownChannelId, "system.hello")));
    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": REALTIME_PROTOCOL },
      webSocket: pair[0],
    });
  }

  /** Distributes only within its own channel and only to principals of the requested kind. */
  public publish(
    message: RealtimeMessage,
  ): void {
    const ownChannelId = this.ownChannelId();
    if (ownChannelId === null || message.channelId !== ownChannelId) {
      throw new Error("Realtime message belongs to a foreign channel.");
    }
    const now = Date.now();
    const serialized = JSON.stringify(message);
    for (const webSocket of this.ctx.getWebSockets()) {
      const principal = readAttachment(webSocket);
      if (principal === null || principal.channelId !== ownChannelId) {
        closeSocket(webSocket, SOCKET_REVOKED_CODE, "invalid principal");
        continue;
      }
      if (isExpired(principal, now)) {
        closeSocket(webSocket, SOCKET_EXPIRED_CODE, "authorization expired");
        continue;
      }
      const recipients: readonly RealtimeRecipientKind[] = REALTIME_RECIPIENTS[message.type];
      if (!recipients.includes(principal.kind)) continue;
      try {
        webSocket.send(serialized);
      } catch {
        closeSocket(webSocket, SOCKET_REVOKED_CODE, "connection unavailable");
      }
    }
  }

  public async revokeSession(sessionId: string): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets(`session:${sessionId}`)) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Session revoked");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  public async revokeUser(userId: string): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets(`user:${userId}`)) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Channel access revoked");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  public async revokeToken(tokenId: string): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets(`token:${tokenId}`)) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Overlay token revoked");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  override async alarm(): Promise<void> {
    const webSockets = this.ctx.getWebSockets();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const [securityDeadline, warningDeadline] = await Promise.all([
      this.ctx.storage.get(SECURITY_DEADLINE_KEY),
      this.ctx.storage.get(AD_PREWARNING_DEADLINE_KEY),
    ]);
    const securityDue = typeof securityDeadline === "number" && Number.isFinite(securityDeadline) && securityDeadline <= now;
    const warningDue = typeof warningDeadline === "number" && Number.isFinite(warningDeadline) && warningDeadline <= now;
    const expired = new Set<WebSocket>();

    if (warningDue) await this.ctx.storage.delete(AD_PREWARNING_DEADLINE_KEY);

    const principals = webSockets.map((webSocket) => ({ webSocket, principal: readAttachment(webSocket) }));

    if (securityDue && webSockets.length > 0) {
      for (const { webSocket, principal } of principals) {
        if (principal === null || isExpired(principal, now)) expired.add(webSocket);
      }
    }

    if (securityDue && webSockets.length > 0) try {
      const ownChannelId = this.ownChannelId();
      if (ownChannelId === null) {
        for (const webSocket of webSockets) closeSocket(webSocket, SOCKET_REVOKED_CODE, "invalid channel");
      } else {
        const panelPrincipals = principals.flatMap(({ webSocket, principal }) =>
          principal?.kind === "panel" && !expired.has(webSocket) ? [{ webSocket, principal }] : []);
        const overlayPrincipals = principals.flatMap(({ webSocket, principal }) =>
          principal?.kind === "overlay" && !expired.has(webSocket) ? [{ webSocket, principal }] : []);

        const validSessions = new Set<string>();
        const sessionIds = [...new Set(panelPrincipals.map(({ principal }) => principal.sessionId))];
        if (sessionIds.length > 0) {
          const placeholders = sessionIds.map(() => "?").join(", ");
          const result = await this.env.DB.prepare(
            `SELECT session.session_id, session.user_id, member.role
               FROM auth_sessions AS session
               JOIN twitch_login_identity AS identity ON identity.user_id = session.user_id
               LEFT JOIN channel_members AS member
                 ON member.channel_id = ? AND member.user_id = session.user_id
              WHERE session.session_id IN (${placeholders})
                AND session.revoked_at IS NULL
                AND session.expires_at > ?
                AND identity.status <> 'revoked'`,
          ).bind(ownChannelId, ...sessionIds, nowIso).all<SessionValidityRow>();
          for (const row of result.results) {
            if (row.role !== null) validSessions.add(`${row.session_id}:${row.user_id}:${row.role}`);
          }
        }

        const validTokens = new Set<string>();
        const tokenIds = [...new Set(overlayPrincipals.map(({ principal }) => principal.tokenId))];
        if (tokenIds.length > 0) {
          const placeholders = tokenIds.map(() => "?").join(", ");
          const result = await this.env.DB.prepare(
            `SELECT token_id
               FROM overlay_tokens
              WHERE channel_id = ?
                AND token_id IN (${placeholders})
                AND revoked_at IS NULL
                AND (expires_at IS NULL OR expires_at > ?)`,
          ).bind(ownChannelId, ...tokenIds, nowIso).all<TokenValidityRow>();
          for (const row of result.results) validTokens.add(row.token_id);
        }

        for (const { webSocket, principal } of panelPrincipals) {
          if (!validSessions.has(`${principal.sessionId}:${principal.userId}:${principal.role}`)) {
            expired.add(webSocket);
          }
        }
        for (const { webSocket, principal } of overlayPrincipals) {
          if (!validTokens.has(principal.tokenId)) expired.add(webSocket);
        }
      }
    } catch (error: unknown) {
      // On a database error, connections are closed for safety; an alarm
      // must not leave access open that can no longer be verified.
      console.error("Realtime authorization check failed.", error);
      for (const webSocket of webSockets) expired.add(webSocket);
    }

    for (const webSocket of expired) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Authorization revoked");
    }

    if (securityDue) {
      if (this.ctx.getWebSockets().length === 0) {
        await this.ctx.storage.delete(SECURITY_DEADLINE_KEY);
      } else {
        await this.ctx.storage.put(SECURITY_DEADLINE_KEY, now + SECURITY_ALARM_INTERVAL_MS);
      }
    } else if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.delete(SECURITY_DEADLINE_KEY);
    }

    const ownChannel = this.ownChannelId();
    if (warningDue && typeof warningDeadline === "number" && ownChannel !== null) {
      try {
        await processAdPrewarning(
          this.env,
          ownChannel,
          warningDeadline,
          undefined,
          nowIso,
          fetch,
          // Own scheduler instead of a stub: a stub to this same object would
          // be a self-call from within alarm() and would never return.
          {
            schedule: async (dueAtMs) => { await this.scheduleAdPrewarning(dueAtMs); },
            clear: async () => { await this.clearAdPrewarning(); },
          },
        );
      } catch (error: unknown) {
        // A flow or D1 error must not swallow the other deadlines that are due.
        console.error("Ad prewarning could not be processed in the alarm.", error);
      }
    }
    await this.scheduleEarliestAlarm();
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    // The channel is one-way; incoming messages are ignored.
    void webSocket;
    void message;
  }

  override webSocketClose(webSocket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    void webSocket;
    void code;
    void reason;
    void wasClean;
    void this.stopSecurityAlarmIfIdle();
  }
}
