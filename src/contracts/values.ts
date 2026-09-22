export const CHANNEL_ROLES = ["broadcaster", "manager", "operator"] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

export const AUDIT_ACTOR_KINDS = ["member", "platform_admin"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const EVENT_TONES = ["info", "warning", "error"] as const;
export type EventTone = (typeof EVENT_TONES)[number];

export const IDENTITY_STATUSES = ["connected", "revoked", "error"] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export type EventSubAuthorizationIdentity =
  | { kind: "bot"; userId: string }
  | { kind: "login"; userId: string };

/**
 * Die Abotypen, die der Bot bei Twitch fuehrt. Sie stehen hier und nicht beim
 * Worker, weil `modules/kanalereignisse` und `dashboard/module-labels` sie
 * brauchen und die Modulgrenze sie nicht aus `worker/` holen laesst. Die
 * Bedingungen zum Anlegen bleiben dagegen im Worker -- nur er baut sie.
 * `tests/unit/eventsub-types.test.ts` haelt Tupel und Tabelle deckungsgleich.
 */
export const EVENTSUB_SUBSCRIPTION_TYPES = [
  "automod.message.hold",
  "channel.ad_break.begin",
  "channel.chat.message",
  "channel.chat.notification",
  "channel.moderate",
  "channel.raid",
  "channel.shoutout.create",
  "channel.shoutout.receive",
  "channel.suspicious_user.message",
  "channel.suspicious_user.update",
  "stream.online",
] as const;
export type EventSubSubscriptionType = (typeof EVENTSUB_SUBSCRIPTION_TYPES)[number];

export const isEventSubSubscriptionType = (value: string): value is EventSubSubscriptionType =>
  (EVENTSUB_SUBSCRIPTION_TYPES as readonly string[]).includes(value);
