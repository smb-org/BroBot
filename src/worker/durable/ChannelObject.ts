import { DurableObject } from "cloudflare:workers";

/**
 * Kanalgebundener Echtzeitraum. Der Name des Durable Objects wird später aus
 * dem channelId-Mandantenschlüssel gebildet.
 */
export class ChannelObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Die SQLite-Storage ist ab Tag 1 Teil des DO-Gerüsts; Fachtabellen folgen später.
    void this.ctx.storage.sql;
  }

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("ChannelObject-Gerüst", { status: 426 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
    });
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    // TODO: Später Protokollversion, Authentifizierung und fachliche Ereignisse
    // auswerten.
    void webSocket;
    void message;
  }

  override webSocketClose(webSocket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // TODO: Später Kanalzustand und Socket-Metadaten aufräumen.
    void webSocket;
    void code;
    void reason;
    void wasClean;
  }
}
