import type { HelixResult } from "../../modules/contract";
import { getLoginIdentity, type LoginIdentityRecord } from "../db/login-identity";
import { TwitchApiError } from "../bot-maintenance";
import { decryptLoginIdentityAccessToken, refreshLoginIdentityTokens, type LoginTokenRefreshEnvironment } from "./login-token-refresh";
import { markLoginRevoked } from "../login-maintenance";

const BROADCASTER_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1_000;

export interface BroadcasterTokenEnvironment extends LoginTokenRefreshEnvironment {
  CHANNEL?: Env["CHANNEL"];
}

export interface BroadcasterTokenDependencies {
  now?: () => string;
  fetcher?: typeof fetch;
  beforeCall?: () => Promise<boolean>;
  refresh?: "allow" | "never";
}

export type BroadcasterTokenResult<Data> =
  | { kind: "ok"; value: Data }
  | { kind: "not_connected" }
  | { kind: "token_unavailable" }
  | { kind: "scope_missing"; missing: string[] }
  | { kind: "revoked"; source: "stored" | "refresh" }
  | { kind: "refresh_failed" }
  | { kind: "request_failed" }
  | { kind: "precondition_failed" }
  | { kind: "http_error"; result: Extract<HelixResult<Data>, { ok: false }> };

const parseTokenScopes = (identity: LoginIdentityRecord): string[] => {
  try {
    const scopes: unknown = JSON.parse(identity.tokenScopesJson);
    return Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string") ? scopes : [];
  } catch {
    return [];
  }
};

const missingScopes = (identity: LoginIdentityRecord, requiredScopes: readonly string[]): string[] => {
  const granted = new Set(parseTokenScopes(identity));
  return requiredScopes.filter((scope) => !granted.has(scope));
};

const isReplacementIdentity = (
  current: LoginIdentityRecord | null,
  expected: LoginIdentityRecord,
): boolean => current !== null &&
  current.userId === expected.userId &&
  current.status === "connected" &&
  (current.accessTokenCiphertext !== expected.accessTokenCiphertext ||
    current.refreshTokenCiphertext !== expected.refreshTokenCiphertext);

type RefreshResult =
  | { kind: "refreshed"; identity: LoginIdentityRecord }
  | { kind: "replacement"; identity: LoginIdentityRecord }
  | { kind: "revoked" }
  | { kind: "not_connected" }
  | { kind: "failed" };

const refreshIdentityOnce = async (
  environment: BroadcasterTokenEnvironment,
  identity: LoginIdentityRecord,
  now: string,
  fetcher: typeof fetch,
): Promise<RefreshResult> => {
  let current: LoginIdentityRecord | null;
  try {
    current = await getLoginIdentity(environment.DB, identity.userId);
  } catch {
    return { kind: "failed" };
  }
  if (current?.status === "revoked") return { kind: "revoked" };
  if (current === null || current.status !== "connected") return { kind: "not_connected" };
  if (isReplacementIdentity(current, identity)) return { kind: "replacement", identity: current };

  try {
    const refreshed = await refreshLoginIdentityTokens(environment, identity, now, fetcher);
    if (refreshed === null) {
      const current = await getLoginIdentity(environment.DB, identity.userId);
      if (current?.status === "revoked") return { kind: "revoked" };
      if (current !== null && isReplacementIdentity(current, identity)) return { kind: "replacement", identity: current };
      return { kind: "not_connected" };
    }
    if (refreshed.status === "revoked") return { kind: "revoked" };
    if (refreshed.status !== "connected") return { kind: "not_connected" };
    return { kind: "refreshed", identity: refreshed };
  } catch (error: unknown) {
    if (!(error instanceof TwitchApiError) || error.code !== "invalid_grant") return { kind: "failed" };

    try {
      await markLoginRevoked(environment, identity, now, "authorization_revoked");
    } catch {
      // The identity write may have committed before a realtime notification failed.
    }

    const current = await getLoginIdentity(environment.DB, identity.userId);
    if (current?.status === "revoked") return { kind: "revoked" };
    if (current !== null && isReplacementIdentity(current, identity)) return { kind: "replacement", identity: current };
    return current === null || current.status !== "connected"
      ? { kind: "not_connected" }
      : { kind: "failed" };
  }
};

const accessTokenFor = async (identity: LoginIdentityRecord, environment: BroadcasterTokenEnvironment): Promise<string | null> => {
  try {
    return await decryptLoginIdentityAccessToken(identity, environment);
  } catch {
    return null;
  }
};

const isNearExpiry = (expiresAt: string, now: string): boolean => {
  const expiryTime = Date.parse(expiresAt);
  const currentTime = Date.parse(now);
  return !Number.isFinite(expiryTime) || !Number.isFinite(currentTime) ||
    expiryTime <= currentTime + BROADCASTER_TOKEN_REFRESH_WINDOW_MS;
};

const isExpired = (expiresAt: string, now: string): boolean => {
  const expiryTime = Date.parse(expiresAt);
  const currentTime = Date.parse(now);
  return !Number.isFinite(expiryTime) || !Number.isFinite(currentTime) || expiryTime <= currentTime;
};

const replacementAfterRequest = async (
  environment: BroadcasterTokenEnvironment,
  identity: LoginIdentityRecord,
): Promise<LoginIdentityRecord | null> => {
  try {
    const current = await getLoginIdentity(environment.DB, identity.userId);
    return isReplacementIdentity(current, identity) ? current : null;
  } catch {
    return null;
  }
};

/** Loads, checks, refreshes, and uses one broadcaster token for a single Helix operation. */
export const withBroadcasterToken = async <Data>(
  environment: BroadcasterTokenEnvironment,
  channelId: string,
  requiredScopes: readonly string[],
  call: (accessToken: string) => Promise<HelixResult<Data>>,
  dependencies: BroadcasterTokenDependencies = {},
): Promise<BroadcasterTokenResult<Data>> => {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const fetcher = dependencies.fetcher ?? fetch;
  let identity = await getLoginIdentity(environment.DB, channelId);
  if (identity === null) return { kind: "not_connected" };
  if (identity.status === "revoked") return { kind: "revoked", source: "stored" };
  if (identity.status !== "connected") return { kind: "not_connected" };

  const initiallyMissing = missingScopes(identity, requiredScopes);
  if (initiallyMissing.length > 0) return { kind: "scope_missing", missing: initiallyMissing };

  let refreshSpent = false;
  if (isNearExpiry(identity.expiresAt, now())) {
    if (dependencies.refresh === "never") {
      if (isExpired(identity.expiresAt, now())) return { kind: "refresh_failed" };
    } else {
      refreshSpent = true;
      const refreshResult = await refreshIdentityOnce(environment, identity, now(), fetcher);
      if (refreshResult.kind === "revoked") return { kind: "revoked", source: "refresh" };
      if (refreshResult.kind === "not_connected") return { kind: "not_connected" };
      if (refreshResult.kind === "failed") return { kind: "refresh_failed" };
      identity = refreshResult.identity;
      const missing = missingScopes(identity, requiredScopes);
      if (missing.length > 0) return { kind: "scope_missing", missing };
    }
  }

  let accessToken = await accessTokenFor(identity, environment);
  if (accessToken === null) return { kind: "token_unavailable" };

  if (dependencies.beforeCall !== undefined) {
    try {
      if (!await dependencies.beforeCall()) return { kind: "precondition_failed" };
    } catch {
      return { kind: "request_failed" };
    }
  }

  let result: HelixResult<Data>;
  try {
    result = await call(accessToken);
  } catch {
    return { kind: "request_failed" };
  }
  if (result.ok) return { kind: "ok", value: result.data };
  if (result.status !== 401) return { kind: "http_error", result };

  if (refreshSpent || dependencies.refresh === "never") {
    const replacement = await replacementAfterRequest(environment, identity);
    if (replacement === null) return { kind: "http_error", result };
    identity = replacement;
  } else {
    const refreshResult = await refreshIdentityOnce(environment, identity, now(), fetcher);
    if (refreshResult.kind === "revoked") return { kind: "revoked", source: "refresh" };
    if (refreshResult.kind === "not_connected") return { kind: "not_connected" };
    if (refreshResult.kind === "failed") return { kind: "refresh_failed" };
    identity = refreshResult.identity;
  }

  const missing = missingScopes(identity, requiredScopes);
  if (missing.length > 0) return { kind: "scope_missing", missing };
  accessToken = await accessTokenFor(identity, environment);
  if (accessToken === null) return { kind: "token_unavailable" };

  if (dependencies.beforeCall !== undefined) {
    try {
      if (!await dependencies.beforeCall()) return { kind: "precondition_failed" };
    } catch {
      return { kind: "request_failed" };
    }
  }

  try {
    result = await call(accessToken);
  } catch {
    return { kind: "request_failed" };
  }
  return result.ok ? { kind: "ok", value: result.data } : { kind: "http_error", result };
};
