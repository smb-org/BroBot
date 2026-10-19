import { PanelApiError } from "../../../contracts/panel-error";
import type { PointsSettings } from "../contracts";

const basePath = (channelId: string): string => `/api/channels/${encodeURIComponent(channelId)}/modules/points`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok && response.status !== 202) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as Value;
};

export interface PointsAccount {
  accountId: string;
  login: string;
  balance: number;
  monthNet: number | null;
}

export type PointsAccountDetail = Pick<PointsAccount, "accountId" | "login" | "balance">;

export interface PointsHistoryRow {
  operationId: string;
  kind: string;
  moduleId: string;
  delta: number;
  balanceAfter: number;
  at: string;
  detail: unknown;
}

export interface PointsSummary {
  circulation: number;
  jackpots: Record<string, number>;
  inRounds: number;
  accounts: number;
  month: string;
}

export const loadPointsAccounts = async (channelId: string, sort: "balance" | "month", q: string, cursor: string | undefined, signal?: AbortSignal) => {
  const params = new URLSearchParams({ sort });
  if (q.trim().length > 0) params.set("q", q.trim());
  if (cursor !== undefined) params.set("cursor", cursor);
  return readJson<{ rows: PointsAccount[]; cursor?: string }>(await fetch(`${basePath(channelId)}/accounts?${params.toString()}`, signal === undefined ? undefined : { signal }));
};

export const loadPointsAccount = async (channelId: string, accountId: string, signal?: AbortSignal): Promise<PointsAccountDetail> =>
  readJson<PointsAccountDetail>(await fetch(`${basePath(channelId)}/accounts/${encodeURIComponent(accountId)}`, signal === undefined ? undefined : { signal }));

export const loadPointsSummary = async (channelId: string, signal?: AbortSignal): Promise<PointsSummary> =>
  readJson<PointsSummary>(await fetch(`${basePath(channelId)}/summary`, signal === undefined ? undefined : { signal }));

export const loadPointsHistory = async (channelId: string, accountId: string, cursor: string | undefined, signal?: AbortSignal) => {
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set("cursor", cursor);
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  return readJson<{ rows: PointsHistoryRow[]; cursor?: string }>(await fetch(`${basePath(channelId)}/accounts/${encodeURIComponent(accountId)}/history${suffix}`, signal === undefined ? undefined : { signal }));
};

export const loadPointsRank = async (channelId: string, accountId: string, signal?: AbortSignal) =>
  readJson<{ rank: number | null; net: number }>(await fetch(`${basePath(channelId)}/accounts/${encodeURIComponent(accountId)}/rank`, signal === undefined ? undefined : { signal }));

export const loadPointsSettings = async (channelId: string, signal?: AbortSignal): Promise<{ settings: PointsSettings; revision: number }> => {
  return readJson<{ settings: PointsSettings; revision: number }>(await fetch(`${basePath(channelId)}/settings`, signal === undefined ? undefined : { signal }));
};

export const savePointsSettings = async (channelId: string, revision: number, settings: PointsSettings): Promise<{ settings: PointsSettings; revision: number }> => {
  const token = await readJson<{ token: string }>(await fetch("/api/csrf"));
  return readJson<{ settings: PointsSettings; revision: number }>(await fetch(`${basePath(channelId)}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token.token },
    body: JSON.stringify({ revision, settings }),
  }));
};

export const adjustPoints = async (channelId: string, accountId: string, operationId: string, delta: number, reason: string) => {
  const tokenResponse = await readJson<{ token: string }>(await fetch("/api/csrf"));
  const response = await fetch(`${basePath(channelId)}/accounts/${encodeURIComponent(accountId)}/adjust`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": tokenResponse.token },
    body: JSON.stringify({ operationId, delta, reason }),
  });
  return readJson<{ balance: number; auditPending: boolean }>(response);
};
