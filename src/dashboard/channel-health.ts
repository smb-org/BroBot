import type {
  PanelBotPermissions,
  PanelBotStatus,
  PanelBroadcasterPermissions,
  PanelModeratorStatus,
  PanelTokenStatus,
} from "../panel-contract";
import { TOKEN_MAINTENANCE_WINDOW_MS } from "../maintenance-policy";
import { dashboardTexts } from "./locale";

type TokenHealthKind =
  | "bot-unavailable"
  | "login-unavailable"
  | "identity-missing"
  | "unchecked"
  | "expired"
  | "refreshing"
  | "maintenance-overdue"
  | "renewal-overdue"
  | "healthy";

export interface TokenHealth {
  tone: "healthy" | "warning" | "error" | "neutral";
  label: string;
  kind: TokenHealthKind;
}

export const parseDashboardDate = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const renewalOverdue = (expiresAt: number, lastMaintenanceAt: number, now: number): boolean =>
  expiresAt <= now + TOKEN_MAINTENANCE_WINDOW_MS &&
  lastMaintenanceAt >= expiresAt - TOKEN_MAINTENANCE_WINDOW_MS;

export const tokenHealth = (
  tokens: PanelTokenStatus,
  bot: PanelBotStatus | null,
  loadedAt?: number,
  now = Date.now(),
): TokenHealth => {
  const texts = dashboardTexts();
  if (bot?.status === "error" || bot?.status === "revoked") {
    return { tone: "error", label: bot.status === "revoked" ? texts.status.revoked : texts.status.error, kind: "bot-unavailable" };
  }
  if (tokens.loginStatus === "error" || tokens.loginStatus === "revoked") {
    return { tone: "error", label: tokens.loginStatus === "revoked" ? texts.status.revoked : texts.status.error, kind: "login-unavailable" };
  }
  if (tokens.loginStatus === null) return { tone: "neutral", label: texts.status.loginIdentityMissing, kind: "identity-missing" };
  const botExpiresAt = parseDashboardDate(tokens.botExpiresAt);
  const loginExpiresAt = parseDashboardDate(tokens.loginExpiresAt);
  if (botExpiresAt === null || loginExpiresAt === null) return { tone: "neutral", label: texts.status.notChecked, kind: "unchecked" };
  const expiredAtLoad = loadedAt !== undefined && (botExpiresAt <= loadedAt || loginExpiresAt <= loadedAt);
  if (expiredAtLoad) return { tone: "error", label: texts.status.expired, kind: "expired" };
  if (botExpiresAt <= now || loginExpiresAt <= now) return { tone: "neutral", label: texts.status.refreshing, kind: "refreshing" };
  if (bot?.status !== "connected") return { tone: "neutral", label: texts.status.notChecked, kind: "unchecked" };
  const lastMaintenanceAt = parseDashboardDate(bot.updatedAt);
  if (lastMaintenanceAt === null || lastMaintenanceAt <= now - TOKEN_MAINTENANCE_WINDOW_MS) {
    return { tone: "warning", label: texts.status.maintenanceOverdue, kind: "maintenance-overdue" };
  }
  if (renewalOverdue(botExpiresAt, lastMaintenanceAt, now) || renewalOverdue(loginExpiresAt, lastMaintenanceAt, now)) {
    return { tone: "warning", label: texts.status.renewalOverdue, kind: "renewal-overdue" };
  }
  return { tone: "healthy", label: texts.status.valid, kind: "healthy" };
};

export const moderatorIsMissing = (moderator: PanelModeratorStatus | null): boolean =>
  moderator?.isModerator === false;

export const botPermissionsAreMissing = (permissions: PanelBotPermissions | null | undefined): permissions is PanelBotPermissions =>
  permissions !== null && permissions !== undefined && permissions.missingScopes.length > 0;

export const broadcasterPermissionsAreMissing = (
  permissions: PanelBroadcasterPermissions | null | undefined,
): permissions is PanelBroadcasterPermissions =>
  permissions !== null && permissions !== undefined && permissions.missingScopes.length > 0;

export const modulePermissionsAreMissing = (
  module: { missingBroadcasterScopes?: readonly string[] } | null | undefined,
): boolean => (module?.missingBroadcasterScopes?.length ?? 0) > 0;
