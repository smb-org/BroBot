import type {
  AuditActorKind,
  ChannelRole,
  EventSubSubscriptionType,
  EventTone,
  IdentityStatus,
} from "./contracts/values";

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
  tokens: PanelTokenStatus;
  lastError: PanelLastError | null;
}

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
  /** Vom Modul deklarierte Zustimmung, vor einer Weiterleitung angezeigt. */
  requiredBroadcasterScopes?: string[];
  /** Deklarierte Scopes, die die Broadcaster-Identität aktuell noch nicht nachweist. */
  missingBroadcasterScopes?: string[];
}

export interface PanelModulesResponse {
  modules: PanelModuleState[];
}

export interface PanelChannelsResponse {
  channels: PanelChannelState[];
  platformAdmin: boolean;
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
   * Broadcaster im gesamten Kanal, nicht auf dieser Seite. Die Oberfläche
   * braucht die Zahl, um den letzten Broadcaster zu erkennen, und darf sie
   * bei seitenweiser Liste nicht selbst ermitteln.
   */
  broadcasterCount: number;
  /**
   * Twitch-User-ID der abrufenden Person. Die Oberfläche muss den eigenen
   * Eintrag erkennen, um Selbstentzug und Selbstherabstufung richtig
   * darzustellen; sie kennt ihn sonst nirgends.
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
}

export interface PanelAuditResponse {
  entries: PanelAuditEntry[];
  nextCursor: string | null;
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
  person: string | null;
}

export interface PanelEventsResponse {
  entries: PanelEventEntry[];
  nextCursor: string | null;
}
