export const CHANNEL_ROLES = ["broadcaster", "manager", "operator"] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

/**
 * Named role thresholds per docs/decisions/0006-rollenschwellen.md, so a
 * threshold is written once and not as a scattered `role !== "operator"` or
 * a raw `'broadcaster', 'manager'` SQL literal. `canManage` is the shared
 * "verwaltend" threshold from that decision -- both the dashboard (read-only
 * UI gating) and the worker (`db/guards.ts`'s `sqlRole`/`sqlRoleList` render
 * these same sets into SQL) use it, so the two can't drift apart.
 */
export const MANAGING_ROLES = ["broadcaster", "manager"] as const satisfies readonly ChannelRole[];
export const PLATFORM_ASSIGNABLE_ROLES = ["manager", "operator"] as const satisfies readonly ChannelRole[];

export const canManage = (role: ChannelRole): boolean =>
  (MANAGING_ROLES as readonly ChannelRole[]).includes(role);

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
  "ads.commercial.failed",
  "host.clip.failed",
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
  "ads.commercial_started",
  "clip.created",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The closed vocabulary of `{ "error": "<code>" }` responses the worker
 * (and, client-side, `dashboard/api.ts`'s own request guard) sends instead
 * of German prose. `dashboard/locale.ts`'s `apiErrorTexts` is a
 * `Record<ApiErrorCode, string>` per language, the same reasoning as
 * `EVENT_CODES` above: the compiler refuses a build where a code here has
 * no catalogue entry. An unrecognized or missing code (old worker, a proxy's
 * HTML error page, a network failure) is not a type error at the response
 * boundary -- `PanelApiError.code` is `string | null` -- so the dashboard
 * falls back to a generic, per-call-site localized text instead of ever
 * showing raw server text.
 */
export const API_ERROR_CODES = [
  "session_missing",
  "csrf_invalid",
  "channel_missing",
  "channel_access_denied",
  "platform_access_denied",
  "panel_request_not_allowed",
  "pagination_limit_invalid",
  "pagination_cursor_invalid",
  "twitch_login_invalid",
  "twitch_user_not_found",
  "twitch_user_search_failed",
  "channel_not_found",
  "broadcaster_role_immutable",
  "broadcaster_role_change_requires_broadcaster",
  "mutation_failed",
  "member_changed_concurrently",
  "release_input_invalid",
  "channel_already_released",
  "channel_release_failed",
  "full_consent_invalid",
  "full_consent_already_set",
  "member_or_role_invalid",
  "member_already_exists",
  "member_management_denied",
  "self_membership_denied",
  "member_add_failed",
  "role_invalid",
  "member_not_found",
  "role_already_set",
  "self_role_escalation_denied",
  "last_broadcaster_cannot_be_demoted",
  "last_broadcaster_cannot_be_removed",
  "event_origin_invalid",
  "event_tone_invalid",
  "moderator_status_check_denied",
  "moderator_status_check_rate_limited",
  "moderator_status_check_failed",
  "module_management_denied",
  "module_unknown",
  "module_not_configured",
  "module_settings_invalid",
  "module_settings_changed_concurrently",
  "module_enabled_field_invalid",
  "module_changed_concurrently",
  "command_management_denied",
  "command_data_invalid",
  "command_already_exists",
  "command_creation_denied",
  "command_not_found",
  "command_update_denied",
  "command_changed_concurrently",
  "command_delete_denied",
  "ad_schedule_read_failed",
  "ad_snooze_failed",
  "commercial_length_invalid",
  "commercial_start_failed",
  "clip_create_failed",
  "shoutout_send_failed",
  "overlay_token_manage_denied",
  "overlay_expiry_invalid",
  "overlay_revocation_reason_invalid",
  "overlay_token_not_found",
  "overlay_token_invalid",
  "unknown_api_route",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
