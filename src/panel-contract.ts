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

export interface PanelModuleState {
  id: string;
  enabled: boolean;
  settings: string;
}

export interface PanelModulesResponse {
  modules: PanelModuleState[];
}

export interface PanelChannelsResponse {
  channels: PanelChannelState[];
}

export interface PanelMember {
  userId: string;
  login: string | null;
  displayName: string | null;
  role: PanelChannelRole;
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

export interface PanelEventEntry {
  eventId: string;
  createdAt: string;
  moduleId: string;
  code: string;
  detail: string;
  actorUserId: string | null;
  actorLogin: string | null;
  actorDisplayName: string | null;
}

export interface PanelEventsResponse {
  entries: PanelEventEntry[];
  nextCursor: string | null;
}
