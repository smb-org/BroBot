import type { ChannelRole, ChannelStreamState } from "./contracts/values";
import type { AdsSchedule } from "./modules/ads/contracts";
import type { PanelChannelControls } from "./panel-contract";

/** The only protocol version used on the wire. */
export type RealtimeProtocolVersion = 1;

export const REALTIME_PROTOCOL = "brobot.v1";
export const OVERLAY_TOKEN_SUBPROTOCOL_PREFIX = "brobot.token.";
export const OVERLAY_ACCESS_BOUND_CLOSE_CODE = 4005;
export const OVERLAY_ACCESS_BOUND_CLOSE_REASON = "Overlay access bound";

export const REALTIME_MESSAGE_TYPES = [
  "system.hello",
  "event_log.new",
  "variables.changed",
  "overlay.changed",
  "ads.schedule.updated",
  "stream.state.changed",
] as const;
export type FixedRealtimeMessageType = (typeof REALTIME_MESSAGE_TYPES)[number];
export type ModuleOverlayRealtimeMessageType = `modul.${string}.${string}`;

export interface ModuleOverlayRealtimePayloads {
  "modul.text_library.blocks_updated": { blockName: string };
  "modul.text_library.state_changed": {
    reason: "channel.game.changed" | "stream.state.changed" | "template.data.changed" | "channel.update" | "stream.online" | "stream.offline";
  };
}

export type KnownModuleOverlayRealtimeMessageType = keyof ModuleOverlayRealtimePayloads
  | `modul.ads.${string}`
  | `modul.clips.${string}`
  | `modul.channel_events.${string}`
  | `modul.raid.${string}`
  | `modul.sun.${string}`
  | `modul.text_commands.${string}`;
export type RealtimeMessageType = FixedRealtimeMessageType | KnownModuleOverlayRealtimeMessageType;

type ModuleOverlayPayload<Type extends ModuleOverlayRealtimeMessageType> = Type extends `modul.text_library.${string}`
  ? Type extends keyof ModuleOverlayRealtimePayloads ? ModuleOverlayRealtimePayloads[Type] : never
  : Readonly<Record<string, unknown>>;

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
  "variables.changed": {
    set: readonly { name: string; value: number }[];
    removed: readonly string[];
    /** Internal routing metadata. The Durable Object strips it before socket delivery. */
    overlayIdsByVariable?: Readonly<Record<string, readonly string[]>>;
  };
  "overlay.changed": {
    overlayId: string;
    revision: number;
  };
  "ads.schedule.updated": { schedule: AdsSchedule; asOf: string };
  "stream.state.changed": {
    state: ChannelStreamState;
    startedAt: string | null;
    changedAt: string;
    checkedAt?: string;
    controls?: PanelChannelControls;
  };
}

type FixedRealtimeEnvelope<Type extends FixedRealtimeMessageType> = {
  version: RealtimeProtocolVersion;
  id: string;
  createdAt: string;
  channelId: string;
  type: Type;
  payload: RealtimePayloads[Type];
};

/** `overlayIds` is executor routing metadata and is removed before socket delivery. */
export type ModuleOverlayRealtimeEnvelope<Type extends ModuleOverlayRealtimeMessageType = KnownModuleOverlayRealtimeMessageType> = {
  [EnvelopeType in Type]: {
    version: RealtimeProtocolVersion;
    id: string;
    createdAt: string;
    channelId: string;
    type: EnvelopeType;
    payload: ModuleOverlayPayload<EnvelopeType>;
    overlayIds?: readonly string[];
  }
}[Type];

export type RealtimeEnvelope<Type extends RealtimeMessageType = RealtimeMessageType> =
  Type extends FixedRealtimeMessageType ? FixedRealtimeEnvelope<Type>
    : Type extends ModuleOverlayRealtimeMessageType ? ModuleOverlayRealtimeEnvelope<Type>
      : never;

export type RealtimeMessage = { [Type in FixedRealtimeMessageType]: FixedRealtimeEnvelope<Type> }[FixedRealtimeMessageType]
  | ModuleOverlayRealtimeEnvelope<ModuleOverlayRealtimeMessageType>;

export const isModuleOverlayRealtimeMessageType = (type: string): type is ModuleOverlayRealtimeMessageType =>
  /^modul\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_-]*$/u.test(type);

export const isModuleOverlayRealtimeEnvelope = (
  message: RealtimeMessage,
): message is ModuleOverlayRealtimeEnvelope<ModuleOverlayRealtimeMessageType> => isModuleOverlayRealtimeMessageType(message.type);

export type RealtimeRecipientKind = "panel" | "overlay";

/** Every wire type is explicitly limited to the clients allowed to receive it. */
export const REALTIME_RECIPIENTS = {
  "system.hello": ["panel", "overlay"],
  "event_log.new": ["panel"],
  "variables.changed": ["panel", "overlay"],
  "overlay.changed": ["panel", "overlay"],
  "ads.schedule.updated": ["panel"],
  "stream.state.changed": ["panel"],
} as const satisfies Record<FixedRealtimeMessageType, readonly RealtimeRecipientKind[]>;

export const realtimeRecipients = (type: RealtimeMessageType | ModuleOverlayRealtimeMessageType): readonly RealtimeRecipientKind[] =>
  isModuleOverlayRealtimeMessageType(type) ? ["overlay"] : REALTIME_RECIPIENTS[type];

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
  overlayId: string | null;
  expiresAt: string | null;
};

export type RealtimePrincipal = RealtimePanelPrincipal | RealtimeOverlayPrincipal;
