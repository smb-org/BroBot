export type PanelChannelRole = "broadcaster" | "verwalter" | "bediener";

export type PanelBotStatusName = "connected" | "revoked" | "error";
export type PanelLoginStatusName = "connected" | "revoked" | "error";
export type PanelBroadcasterConnectionStatus = "connected" | "not_connected";

export interface PanelBotStatus {
  status: PanelBotStatusName;
  reason: string | null;
  updatedAt: string;
}

export interface PanelModeratorStatus {
  isModerator: boolean;
  checkedAt: string;
  reason: string | null;
}

export interface PanelTokenStatus {
  botExpiresAt: string | null;
  loginStatus: PanelLoginStatusName | null;
  loginReason: string | null;
  loginExpiresAt: string | null;
}

export interface PanelLastError {
  source: "moderator" | "bot" | "login";
  reason: string;
  at: string;
}

export interface PanelChannelState {
  channelId: string;
  login: string;
  displayName: string;
  role: PanelChannelRole;
  broadcasterConnection: PanelBroadcasterConnectionStatus;
  bot: PanelBotStatus | null;
  moderator: PanelModeratorStatus | null;
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

export interface PanelChannelsResponse {
  channels: PanelChannelState[];
}

export interface PanelSystemResponse {
  broadcasterConnection: PanelBroadcasterConnectionStatus;
  bot: PanelBotStatus | null;
  tokens: PanelTokenStatus;
}

export interface PanelAuditEntry {
  auditId: string;
  actorUserId: string;
  createdAt: string;
  action: string;
  before: string;
  after: string;
}

export interface PanelAuditResponse {
  entries: PanelAuditEntry[];
  nextCursor: string | null;
}
