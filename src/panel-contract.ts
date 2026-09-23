import type {
  AuditActorKind,
  AuditArea,
  ChannelControlDuration,
  ChannelStreamState,
  ChannelRole,
  EventSubSubscriptionType,
  EventTone,
  IdentityStatus,
} from "./contracts/values";
import type { TemplateWarning } from "./template";

export type PanelTemplateWarning = TemplateWarning;

export interface PanelTemplateWarningResponse {
  warnings: readonly PanelTemplateWarning[];
}

export interface PanelCommandAliasConflict {
  field: "name" | "aliases";
  trigger: string;
  command: string;
}

export type PanelBroadcasterConnectionStatus = "connected" | "not_connected";
export type PanelChannelBotConsentStatus = "granted" | "missing";
export type PanelChatSubscriptionStatus = "enabled" | "missing" | "error" | "revoked";
export type PanelEventSubSubscriptionStatus = PanelChatSubscriptionStatus | "pending";

export interface PanelBotStatus {
  status: IdentityStatus;
  reason: string | null;
  updatedAt: string;
}

export interface PanelModeratorStatus {
  isModerator: boolean;
  checkedAt: string;
  reason: string | null;
}

export interface PanelChatSubscription {
  status: PanelChatSubscriptionStatus;
  subscriptionId: string | null;
  reason: string | null;
  updatedAt: string;
}

export interface PanelEventSubSubscription {
  subscriptionType: EventSubSubscriptionType;
  variant: string;
  version: string;
  subscriptionId: string | null;
  status: PanelEventSubSubscriptionStatus;
  reason: string | null;
  message: string | null;
  statusCode: number | null;
  updatedAt: string;
}

export interface PanelBotPermissions {
  missingScopes: string[];
}

export interface PanelBroadcasterPermissions {
  missingScopes: string[];
}

export interface PanelTokenStatus {
  botExpiresAt: string | null;
  loginStatus: IdentityStatus | null;
  loginReason: string | null;
  loginExpiresAt: string | null;
}

export interface PanelLastError {
  source: "moderator" | "bot" | "login" | "eventsub";
  reason: string;
  at: string;
  message?: string | null;
  status?: number | null;
  subscriptionType?: EventSubSubscriptionType | undefined;
  subscriptionVariant?: string | undefined;
}

export interface PanelChannelState {
  channelId: string;
  login: string;
  displayName: string;
  role: ChannelRole;
  broadcasterConnection: PanelBroadcasterConnectionStatus;
  channelBotConsent: PanelChannelBotConsentStatus;
  bot: PanelBotStatus | null;
  botPermissions: PanelBotPermissions | null;
  broadcasterPermissions: PanelBroadcasterPermissions | null;
  moderator: PanelModeratorStatus | null;
  chatSubscription: PanelChatSubscription | null;
  chatSubscriptionNeeded?: boolean;
  /** Last EventSub-observed state; null or absent means not known yet. */
  streamState?: ChannelStreamState | null;
  /** EventSub stream.online time, present only while the stored state is online. */
  streamStartedAt?: string | null;
  /** Operational channel brakes; absent only when talking to an older worker. */
  controls?: PanelChannelControls;
  tokens: PanelTokenStatus;
  lastError: PanelLastError | null;
}

export interface PanelChannelControl {
  active: boolean;
  /** Null for off, until stream end, and unlimited controls. */
  until: string | null;
  mode: "timed" | "until_stream_end" | "unlimited" | null;
}

export interface PanelChannelControls {
  mute: PanelChannelControl;
  pause: PanelChannelControl;
}

export type PanelChannelControlDuration = ChannelControlDuration;

export interface PanelActiveModule {
  moduleId: string;
  settings: string;
}

export interface PanelChannelOverview extends PanelChannelState {
  activeModules: PanelActiveModule[];
}

export interface PanelModuleState {
  id: string;
  enabled: boolean;
  settings: string;
  mandatory?: boolean;
  /** Consent declared by the module, shown before a redirect. */
  requiredBroadcasterScopes?: string[];
  /** Declared scopes the broadcaster identity does not currently prove. */
  missingBroadcasterScopes?: string[];
}

export interface PanelModulesResponse {
  modules: PanelModuleState[];
}

export interface PanelChannelsResponse {
  channels: PanelChannelState[];
  /** The installation's single bot identity, independent of which channels
   *  this viewer can see -- present even with zero released channels. */
  bot: PanelBotStatus | null;
  platformAdmin: boolean;
  viewerIsBot: boolean;
  /** Present only for platform admins and the bot account itself. */
  botLogin?: string;
}

export interface PanelPlatformChannel {
  channelId: string;
  login: string;
  displayName: string;
  fullConsent: boolean;
}

export interface PanelPlatformChannelOverview extends PanelPlatformChannel {
  memberCounts: {
    broadcaster: number;
    manager: number;
    operator: number;
  };
  broadcasterConnected: boolean;
}

export interface PanelPlatformOverviewResponse {
  channels: PanelPlatformChannelOverview[];
}

export interface PanelPlatformMembersResponse {
  members: PanelMember[];
  nextCursor: string | null;
  broadcasterCount: number;
  viewerUserId: string;
}

export interface PanelPlatformAuditEntry {
  auditId: string;
  actorUserId: string;
  actorLogin: string | null;
  actorDisplayName: string | null;
  actorKind: AuditActorKind;
  createdAt: string;
  channelId: string;
  moduleId: string | null;
  action: string;
  before: string;
  after: string;
}

export interface PanelPlatformAuditResponse {
  entries: PanelPlatformAuditEntry[];
  nextCursor: string | null;
}

export interface PanelMember {
  userId: string;
  login: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  role: ChannelRole;
  joinedAt: string;
}

export interface PanelMembersResponse {
  members: PanelMember[];
  nextCursor: string | null;
  /**
   * Broadcasters across the whole channel, not on this page. The UI
   * needs this number to recognize the last broadcaster, and must not
   * determine it itself from a paginated list.
   */
  broadcasterCount: number;
  /**
   * Twitch user id of the requesting person. The UI must recognize its
   * own entry to correctly render self-removal and self-demotion; it has
   * no other way of knowing it.
   */
  viewerUserId: string;
}

export interface PanelTwitchUser {
  userId: string;
  login: string;
  displayName: string;
  profileImageUrl: string | null;
}

export interface PanelSystemResponse {
  broadcasterConnection: PanelBroadcasterConnectionStatus;
  bot: PanelBotStatus | null;
  botPermissions: PanelBotPermissions | null;
  broadcasterPermissions: PanelBroadcasterPermissions | null;
  chatSubscription: PanelChatSubscription | null;
  chatSubscriptionNeeded?: boolean;
  subscriptions?: PanelEventSubSubscription[];
  tokens: PanelTokenStatus;
}

export interface PanelAuditEntry {
  auditId: string;
  actorUserId: string;
  actorLogin: string | null;
  actorDisplayName: string | null;
  actorKind: AuditActorKind;
  createdAt: string;
  moduleId: string | null;
  action: string;
  before: string;
  after: string;
  /** The action's target member, when one is stored in `before`/`after` -- resolved server-side alongside the actor (#181). */
  subjectLogin?: string | null;
  subjectDisplayName?: string | null;
}

export interface PanelAuditResponse {
  entries: PanelAuditEntry[];
  nextCursor: string | null;
}

export interface PanelAuditFilters {
  person: string | null;
  area: AuditArea | null;
}

export interface PanelEventEntry {
  eventId: string;
  createdAt: string;
  moduleId: string;
  triggerId: string;
  code: string;
  detail: string;
  actorUserId: string | null;
  actorLogin: string | null;
  actorDisplayName: string | null;
}

export type PanelEventOrigin = "channel" | "module";
export interface PanelEventFilters {
  origin: PanelEventOrigin | null;
  module: string | null;
  tone: EventTone | null;
  /** Multiple selected tones, used by deep links such as warnings + errors. */
  tones?: readonly EventTone[];
  person: string | null;
}

export interface PanelEventsResponse {
  entries: PanelEventEntry[];
  nextCursor: string | null;
}
