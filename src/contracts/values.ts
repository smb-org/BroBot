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
 * The subscription types the bot maintains with Twitch. They live here
 * instead of in the worker because `modules/channel_events` and
 * `dashboard/module-labels` need them, and the module boundary doesn't let
 * them pull it from `worker/`. The conditions for creating them stay in the
 * worker, though -- only it builds them.
 * `tests/unit/eventsub-types.test.ts` keeps the tuple and table in sync.
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
