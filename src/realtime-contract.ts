/** Die einzige auf der Strecke verwendete Protokollversion. */
export type RealtimeProtocolVersion = 1;

export type RealtimeMessageType = "system.hallo" | "ereignisprotokoll.neu";

export interface RealtimeEventLogHint {
  eventId: string;
  createdAt: string;
  moduleId: string;
  code: string;
  actorUserId: string | null;
}

export interface RealtimePayloads {
  "system.hallo": Record<string, never>;
  "ereignisprotokoll.neu": {
    entries: readonly RealtimeEventLogHint[];
  };
}

export type RealtimeEnvelope<Type extends RealtimeMessageType = RealtimeMessageType> = {
  version: RealtimeProtocolVersion;
  id: string;
  createdAt: string;
  channelId: string;
  type: Type;
  payload: RealtimePayloads[Type];
};

export type RealtimeMessage = {
  [Type in RealtimeMessageType]: RealtimeEnvelope<Type>;
}[RealtimeMessageType];

export type RealtimeRecipientKind = "panel" | "overlay";

export type RealtimePanelPrincipal = {
  v: RealtimeProtocolVersion;
  kind: "panel";
  channelId: string;
  userId: string;
  sessionId: string;
  role: "broadcaster" | "verwalter" | "bediener";
  expiresAt: string;
};

export type RealtimeOverlayPrincipal = {
  v: RealtimeProtocolVersion;
  kind: "overlay";
  channelId: string;
  tokenId: string;
  expiresAt: string | null;
};

export type RealtimePrincipal = RealtimePanelPrincipal | RealtimeOverlayPrincipal;
