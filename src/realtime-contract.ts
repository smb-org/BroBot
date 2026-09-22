import type { ChannelRole } from "./contracts/values";

/** Die einzige auf der Strecke verwendete Protokollversion. */
export type RealtimeProtocolVersion = 1;

export type RealtimeMessageType = "system.hello" | "event_log.new";

export interface RealtimeEventLogHint {
  eventId: string;
  createdAt: string;
  moduleId: string;
  code: string;
  actorUserId: string | null;
}

export interface RealtimePayloads {
  "system.hello": Record<string, never>;
  "event_log.new": {
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
  role: ChannelRole;
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
