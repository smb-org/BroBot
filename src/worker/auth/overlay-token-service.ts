import { hashOverlayToken } from "./crypto";
import {
  listActiveOverlayTokens,
  getUsableOverlayToken,
  revokeOverlayToken as revokeStoredOverlayToken,
  touchOverlayToken,
  type ActiveOverlayTokenPage,
  type OverlayTokenRecord,
} from "./overlay-token-repository";
import type {
  ActorContext,
} from "../db/guards";

export interface AuthenticateOverlayTokenInput {
  token: string;
  pepper: string;
  now: string;
}

export interface RevokeOverlayTokenInput {
  channelId: string;
  actor: ActorContext;
  tokenId: string;
  reason: string;
  revokedAt: string;
}

export interface ListActiveOverlayTokensInput {
  channelId: string;
  now: string;
  offset?: number;
}

const LAST_USED_INTERVAL_MS = 5 * 60 * 1000;

const shouldTouchLastUsed = (lastUsedAt: string | null, now: string): boolean => {
  if (lastUsedAt === null) return true;
  const lastUsedTimestamp = Date.parse(lastUsedAt);
  const nowTimestamp = Date.parse(now);
  return !Number.isFinite(lastUsedTimestamp) || !Number.isFinite(nowTimestamp) ||
    nowTimestamp - lastUsedTimestamp >= LAST_USED_INTERVAL_MS;
};

export const getActiveOverlayTokens = async (
  db: D1Database,
  input: ListActiveOverlayTokensInput,
): Promise<ActiveOverlayTokenPage> => listActiveOverlayTokens(db, input.channelId, input.now, input.offset);

export const authenticateOverlayToken = async (
  db: D1Database,
  input: AuthenticateOverlayTokenInput,
): Promise<OverlayTokenRecord | null> => {
  const tokenHash = await hashOverlayToken(input.token, input.pepper);
  const record = await getUsableOverlayToken(db, tokenHash, input.now);
  if (record === null || !shouldTouchLastUsed(record.lastUsedAt, input.now)) return record;

  const nowTimestamp = Date.parse(input.now);
  if (!Number.isFinite(nowTimestamp)) throw new Error("Usage timestamp is invalid.");
  const cutoff = new Date(nowTimestamp - LAST_USED_INTERVAL_MS).toISOString();
  let touched: boolean;
  try {
    touched = await touchOverlayToken(db, record.channelId, record.tokenId, input.now, cutoff);
  } catch {
    return record;
  }
  if (touched) return { ...record, lastUsedAt: input.now };
  return getUsableOverlayToken(db, tokenHash, input.now);
};

export const revokeOverlayToken = async (
  db: D1Database,
  input: RevokeOverlayTokenInput,
): Promise<boolean> => revokeStoredOverlayToken(
  db,
  input.channelId,
  input.tokenId,
  input.revokedAt,
  input.reason,
  input.actor,
);
