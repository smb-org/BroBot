import { DurableObject } from "cloudflare:workers";

import type {
  RealtimeEnvelope,
  RealtimePrincipal,
  RealtimeRecipientKind,
} from "../../realtime-contract";
import { CHANNEL_ROLES, type ChannelRole } from "../../contracts/values";
import { verarbeiteWerbevorwarnung } from "../werbe-vorwarnung";
import { REALTIME_PRINCIPAL_HEADER, REALTIME_PROTOCOL } from "../realtime-protocol";

const SECURITY_ALARM_INTERVAL_MS = 15 * 60 * 1000;
// Beim Reset wird die Durable-Object-Klasse verworfen; deshalb sind neue Schlüssel
// sicher. Ohne diesen Reset fände scheduleEarliestAlarm() alte Fristen nicht,
// löschte den Wecker lautlos, und Sicherheitsrunde sowie Werbevorwarnung fielen aus.
const SECURITY_DEADLINE_KEY = "security_round";
const WERBEVORWARNUNG_DEADLINE_KEY = "ad_prewarning";
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
    // Der Socket kann zwischen Auswahl und close bereits geschlossen worden sein.
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
 * Kanalgebundener Echtzeitraum. Hibernation ist hier eine harte Invariante:
 * kein Klassenfeld enthält Zustand, der nach dem Wecken noch stimmen muss.
 * Prinzipale und Tags leben am Socket, die einzige periodische Arbeit im
 * Wecker und die Berechtigungsdaten liegen in D1.
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
      this.ctx.storage.get(WERBEVORWARNUNG_DEADLINE_KEY),
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

  public async planeWerbevorwarnung(faelligAmMs: number): Promise<void> {
    if (!Number.isFinite(faelligAmMs)) {
      await this.loescheWerbevorwarnung();
      return;
    }
    await this.ctx.storage.put(WERBEVORWARNUNG_DEADLINE_KEY, faelligAmMs);
    await this.scheduleEarliestAlarm();
  }

  public async loescheWerbevorwarnung(): Promise<void> {
    await this.ctx.storage.delete(WERBEVORWARNUNG_DEADLINE_KEY);
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
      return new Response("Kanalzugriff verweigert.", { status: 403 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket-Upgrade erforderlich.", { status: 426 });
    }
    if (request.headers.get("Sec-WebSocket-Protocol") !== REALTIME_PROTOCOL) {
      return new Response("Realtime-Protokoll wird nicht unterstützt.", { status: 426 });
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

  /** Verteilt nur im eigenen Kanal und nur an Prinzipale der gewünschten Art. */
  public publish(
    message: RealtimeEnvelope,
    recipient: RealtimeRecipientKind = "panel",
  ): void {
    const ownChannelId = this.ownChannelId();
    if (ownChannelId === null || message.channelId !== ownChannelId) {
      throw new Error("Realtime-Nachricht gehört zu einem fremden Kanal.");
    }
    const now = Date.now();
    const serialized = JSON.stringify(message);
    for (const webSocket of this.ctx.getWebSockets()) {
      const principal = readAttachment(webSocket);
      if (principal === null || principal.channelId !== ownChannelId) {
        closeSocket(webSocket, SOCKET_REVOKED_CODE, "Prinzipal ungültig");
        continue;
      }
      if (isExpired(principal, now)) {
        closeSocket(webSocket, SOCKET_EXPIRED_CODE, "Berechtigung abgelaufen");
        continue;
      }
      if (principal.kind !== recipient) continue;
      try {
        webSocket.send(serialized);
      } catch {
        closeSocket(webSocket, SOCKET_REVOKED_CODE, "Verbindung nicht verfügbar");
      }
    }
  }

  public async revokeSession(sessionId: string): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets(`session:${sessionId}`)) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Sitzung widerrufen");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  public async revokeUser(userId: string): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets(`user:${userId}`)) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Kanalzugriff widerrufen");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  public async revokeToken(tokenId: string): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets(`token:${tokenId}`)) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Overlay-Token widerrufen");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  override async alarm(): Promise<void> {
    const webSockets = this.ctx.getWebSockets();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const [securityDeadline, warningDeadline] = await Promise.all([
      this.ctx.storage.get(SECURITY_DEADLINE_KEY),
      this.ctx.storage.get(WERBEVORWARNUNG_DEADLINE_KEY),
    ]);
    const securityDue = typeof securityDeadline === "number" && Number.isFinite(securityDeadline) && securityDeadline <= now;
    const warningDue = typeof warningDeadline === "number" && Number.isFinite(warningDeadline) && warningDeadline <= now;
    const expired = new Set<WebSocket>();

    if (warningDue) await this.ctx.storage.delete(WERBEVORWARNUNG_DEADLINE_KEY);

    const principals = webSockets.map((webSocket) => ({ webSocket, principal: readAttachment(webSocket) }));

    if (securityDue && webSockets.length > 0) {
      for (const { webSocket, principal } of principals) {
        if (principal === null || isExpired(principal, now)) expired.add(webSocket);
      }
    }

    if (securityDue && webSockets.length > 0) try {
      const ownChannelId = this.ownChannelId();
      if (ownChannelId === null) {
        for (const webSocket of webSockets) closeSocket(webSocket, SOCKET_REVOKED_CODE, "Kanal ungültig");
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
      // Bei einem Datenbankfehler wird aus Sicherheitsgründen geschlossen;
      // ein Alarm darf keinen nicht mehr prüfbaren Zugriff offen lassen.
      console.error("Realtime-Berechtigungsprüfung fehlgeschlagen.", error);
      for (const webSocket of webSockets) expired.add(webSocket);
    }

    for (const webSocket of expired) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Berechtigung widerrufen");
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

    const eigenerKanal = this.ownChannelId();
    if (warningDue && typeof warningDeadline === "number" && eigenerKanal !== null) {
      try {
        await verarbeiteWerbevorwarnung(
          this.env,
          eigenerKanal,
          warningDeadline,
          undefined,
          nowIso,
          fetch,
          // Eigener Planer statt Stub: Ein Stub auf dieses Objekt waere aus
          // alarm() heraus ein Selbstaufruf und kaeme nie zurueck.
          {
            plane: async (faelligAmMs) => { await this.planeWerbevorwarnung(faelligAmMs); },
            loesche: async () => { await this.loescheWerbevorwarnung(); },
          },
        );
      } catch (error: unknown) {
        // Ein Ablauf- oder D1-Fehler darf die übrigen fälligen Fristen nicht verschlucken.
        console.error("Werbe-Vorwarnung konnte im Alarm nicht verarbeitet werden.", error);
      }
    }
    await this.scheduleEarliestAlarm();
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    // Die Strecke ist einseitig; eingehende Nachrichten werden ignoriert.
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
