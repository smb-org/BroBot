import { hashOverlayToken } from "./crypto";
import {
  createOverlayToken,
  getUsableOverlayToken,
  revokeOverlayToken as revokeStoredOverlayToken,
  touchOverlayToken,
  type OverlayTokenRecord,
} from "./overlay-token-repository";
import type { ActorContext } from "./repository";

export interface IssueOverlayTokenInput {
  channelId: string;
  actor: ActorContext;
  pepper: string;
  publicOrigin: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface IssuedOverlayToken {
  tokenId: string;
  overlayUrl: string;
  expiresAt: string | null;
}

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

const TOKEN_BYTE_LENGTH = 32;
const LAST_USED_INTERVAL_MS = 5 * 60 * 1000;

const encodeBase64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const randomToken = (): string => {
  const bytes = new Uint8Array(new ArrayBuffer(TOKEN_BYTE_LENGTH));
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
};

const normalizeExpiry = (expiresAt: string | null, createdAt: string): string | null => {
  if (expiresAt === null) return null;
  const expiresTimestamp = Date.parse(expiresAt);
  const createdTimestamp = Date.parse(createdAt);
  if (!Number.isFinite(expiresTimestamp) || !Number.isFinite(createdTimestamp) || expiresTimestamp <= createdTimestamp) {
    throw new Error("Overlay-Token-Ablauf muss nach der Ausgabe liegen.");
  }
  return new Date(expiresTimestamp).toISOString();
};

const shouldTouchLastUsed = (lastUsedAt: string | null, now: string): boolean => {
  if (lastUsedAt === null) return true;
  const lastUsedTimestamp = Date.parse(lastUsedAt);
  const nowTimestamp = Date.parse(now);
  return !Number.isFinite(lastUsedTimestamp) || !Number.isFinite(nowTimestamp) ||
    nowTimestamp - lastUsedTimestamp >= LAST_USED_INTERVAL_MS;
};

export const issueOverlayToken = async (
  db: D1Database,
  input: IssueOverlayTokenInput,
): Promise<IssuedOverlayToken | null> => {
  const expiresAt = normalizeExpiry(input.expiresAt, input.createdAt);
  const token = randomToken();
  const tokenId = crypto.randomUUID();
  const issued = await createOverlayToken(db, {
    tokenId,
    channelId: input.channelId,
    tokenHash: await hashOverlayToken(token, input.pepper),
    expiresAt,
    createdAt: input.createdAt,
    revokedAt: null,
    revocationReason: null,
    lastUsedAt: null,
  }, input.actor);
  // Die Mitgliedschaft oder die Session ist zwischen Guard und Mutation
  // erloschen. Es gibt kein Token, also auch keine URL.
  if (!issued) return null;

  const overlayUrl = new URL("/overlay", input.publicOrigin);
  overlayUrl.hash = new URLSearchParams({ token }).toString();
  return { tokenId, overlayUrl: overlayUrl.toString(), expiresAt };
};

export const authenticateOverlayToken = async (
  db: D1Database,
  input: AuthenticateOverlayTokenInput,
): Promise<OverlayTokenRecord | null> => {
  const tokenHash = await hashOverlayToken(input.token, input.pepper);
  const record = await getUsableOverlayToken(db, tokenHash, input.now);
  if (record === null || !shouldTouchLastUsed(record.lastUsedAt, input.now)) return record;

  const nowTimestamp = Date.parse(input.now);
  if (!Number.isFinite(nowTimestamp)) throw new Error("Nutzungszeitpunkt ist ungültig.");
  const cutoff = new Date(nowTimestamp - LAST_USED_INTERVAL_MS).toISOString();
  let touched: boolean;
  try {
    touched = await touchOverlayToken(db, record.tokenId, input.now, cutoff);
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
