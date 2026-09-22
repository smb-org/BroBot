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

/**
 * The diagnostic codes modules and the host write to `event_log.code`.
 * Closed on purpose, the same reasoning as `ModuleDiagnosticDetailKey` in
 * `modules/contract.ts`: a scanner only sees the shapes it was taught, but a
 * union is checked by the compiler at every construction site, however the
 * object is assembled. `dashboard/locale.ts`'s `eventTexts`/`eventToneEntries`
 * are each `Record<EventCode, ...>`, so adding, renaming or removing a code
 * here forces both language catalogues to keep up or the build fails.
 * `tests/unit/event-codes.test.ts` adds a runtime check on top (a cast could
 * still slip a value past the type).
 */
export const EVENT_CODES = [
  "host.action.failed",
  "host.chat.failed",
  "host.chat.sent",
  "host.module.error",
  "host.module.unknown",
  "host.overlay.not_executed",
  "host.shoutout.failed",
  "host.shoutout.sent",
  "channel_events.raid.incoming",
  "channel_events.raid.outgoing",
  "channel_events.shoutout.sent",
  "channel_events.shoutout.received",
  "channel_events.chat.sub",
  "channel_events.chat.resub",
  "channel_events.chat.gift_sub",
  "channel_events.chat.community_gift",
  "channel_events.chat.announcement",
  "channel_events.chat.unknown",
  "channel_events.moderation.ban",
  "channel_events.moderation.timeout",
  "channel_events.moderation.untimeout",
  "channel_events.moderation.unban",
  "channel_events.moderation.delete",
  "channel_events.moderation.warn",
  "channel_events.moderation.unknown",
  "channel_events.automod.held",
  "channel_events.suspicious.message",
  "channel_events.suspicious.classified",
  "channel_events.suspicious.cleared",
  "raid.outgoing",
  "raid.shoutout",
  "raid.invalid",
  "shoutout.suppressed",
  "ads.announcement",
  "ads.skipped",
  "ads.prewarning.announced",
  "ads.prewarning.no_schedule",
  "ads.prewarning.too_late",
  "ads.prewarning.break_started",
  "ads.prewarning.rescheduled",
  "ads.prewarning.scope_missing",
  "ads.prewarning.schedule_error",
  "ads.snooze",
  "text_commands.cooldown",
  "text_commands.triggered",
  "text_commands.disabled",
  "text_commands.permission_denied",
  // Since the removal of the mutating chat commands (#120), nobody generates
  // these two codes anymore. They stay because the event log keeps its rows
  // for 14 days: without a label, entries already written would become
  // unreadable in the panel.
  "text_commands.already_exists",
  "text_commands.not_authorized",
  "text_commands.unknown",
  "text_commands.invalid",
] as const;
export type EventCode = (typeof EVENT_CODES)[number];

/**
 * The `audit_log.action` vocabulary, closed for the same reason as
 * `EVENT_CODES` above. `channel.*`/`member.*` are also `PlatformAction` in
 * `worker/platform/repository.ts` and `dashboard/labels.ts` -- the subset a
 * platform admin's audit view labels; the rest only ever reach the raw,
 * per-channel system audit log, which shows `action` unlabelled. A module's
 * own settings change writes `` `${moduleId}.settings_changed` ``: module
 * ids are already English identifiers, so no catalogue entry is needed for
 * that half.
 */
export const AUDIT_ACTIONS = [
  "channel.released",
  "channel.full_consent_changed",
  "member.added",
  "member.role_changed",
  "member.removed",
  "module.enabled",
  "module.disabled",
  "text_commands.command.created",
  "text_commands.command.updated",
  "text_commands.command.removed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
