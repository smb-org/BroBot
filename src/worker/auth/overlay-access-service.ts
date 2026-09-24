import { decryptJson, encryptJson, getTokenEncryptionKeys, parseKeyRing } from "./crypto";
import { hashOverlayToken } from "./crypto";
import type { ActorContext } from "../db/guards";
import {
  authorizeOverlayAccessManager,
  countActiveOverlayAccesses,
  createOverlayAccess,
  getOverlayAccessForReplacement as getStoredOverlayAccessForReplacement,
  getOverlayAccessForReveal,
  recordOverlayAccessReveal,
  revokeOverlayAccess as revokeStoredOverlayAccess,
  type OverlayAccessListEntry,
  type OverlayAccessMetadata,
  type RevokeOverlayAccessResult,
} from "./overlay-access-repository";
import { listOverlayAccesses } from "./overlay-access-repository";

interface OverlayAccessEnvironment {
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
}

export interface IssueOverlayAccessInput {
  channelId: string;
  overlayId: string;
  label: string;
  expiresAt: string | null;
  actor: ActorContext;
  pepper: string;
  keyRing: string;
  publicOrigin: string;
  createdAt: string;
}

export interface IssuedOverlayAccess {
  tokenId: string;
  overlayUrl: string;
  label: string;
  expiresAt: string | null;
}

export type RevealOverlayAccessResult =
  | { outcome: "revealed"; overlayUrl: string }
  | { outcome: "unrecoverable" | "not_found" | "forbidden" };

export type IssueOverlayAccessResult =
  | { outcome: "issued"; access: IssuedOverlayAccess }
  | { outcome: "rejected" };

const TOKEN_BYTE_LENGTH = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const encodeBase64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const createSecret = (): string => {
  const bytes = new Uint8Array(new ArrayBuffer(TOKEN_BYTE_LENGTH));
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
};

const normalizedExpiry = (expiresAt: string | null, createdAt: string): string | null => {
  if (expiresAt === null) return null;
  const expiry = Date.parse(expiresAt);
  const issued = Date.parse(createdAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(issued) || expiry <= issued) return null;
  return new Date(expiry).toISOString();
};

const overlayUrlFor = (publicOrigin: string, token: string): string => {
  const url = new URL("/overlay", publicOrigin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
};

export const listOverlayAccessesForOverlay = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
): Promise<OverlayAccessListEntry[]> => listOverlayAccesses(db, channelId, overlayId);

export const issueOverlayAccess = async (
  db: D1Database,
  input: IssueOverlayAccessInput,
): Promise<IssueOverlayAccessResult> => {
  const expiresAt = normalizedExpiry(input.expiresAt, input.createdAt);
  if (input.expiresAt !== null && expiresAt === null) return { outcome: "rejected" };

  const token = createSecret();
  const tokenId = crypto.randomUUID();
  const created = await createOverlayAccess(db, {
    tokenId,
    channelId: input.channelId,
    overlayId: input.overlayId,
    tokenHash: await hashOverlayToken(token, input.pepper),
    secretEnvelope: await encryptJson({
      v: 1,
      tokenId,
      channelId: input.channelId,
      token,
    }, parseKeyRing(input.keyRing)),
    label: input.label,
    expiresAt,
    createdAt: input.createdAt,
  }, input.actor);
  if (!created) return { outcome: "rejected" };
  return {
    outcome: "issued",
    access: {
      tokenId,
      overlayUrl: overlayUrlFor(input.publicOrigin, token),
      label: input.label,
      expiresAt,
    },
  };
};

interface StoredAccessEnvelope {
  v: number;
  tokenId: string;
  channelId: string;
  token: string;
}

const isStoredAccessEnvelope = (value: unknown): value is StoredAccessEnvelope =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Reflect.get(value, "v") === 1 &&
  typeof Reflect.get(value, "tokenId") === "string" &&
  typeof Reflect.get(value, "channelId") === "string" &&
  typeof Reflect.get(value, "token") === "string";

export const revealOverlayAccess = async (
  db: D1Database,
  input: {
    channelId: string;
    overlayId: string;
    tokenId: string;
    actor: ActorContext;
    pepper: string;
    keyRing: string;
    publicOrigin: string;
    revealedAt: string;
  },
): Promise<RevealOverlayAccessResult> => {
  const access = await getOverlayAccessForReveal(
    db, input.channelId, input.overlayId, input.tokenId, input.actor, input.revealedAt,
  );
  if (access === null) {
    return await authorizeOverlayAccessManager(db, input.actor, input.channelId, input.revealedAt)
      ? { outcome: "not_found" }
      : { outcome: "forbidden" };
  }
  if (access.secretEnvelope.length === 0) return { outcome: "unrecoverable" };
  const envelope = await decryptJson<unknown>(access.secretEnvelope, parseKeyRing(input.keyRing));
  if (!isStoredAccessEnvelope(envelope) || envelope.tokenId !== access.tokenId ||
      envelope.channelId !== access.channelId || !TOKEN_PATTERN.test(envelope.token) ||
      await hashOverlayToken(envelope.token, input.pepper) !== access.tokenHash) {
    return { outcome: "unrecoverable" };
  }

  const audited = await recordOverlayAccessReveal(db, access, input.actor, input.revealedAt);
  if (!audited) {
    return await authorizeOverlayAccessManager(db, input.actor, input.channelId, input.revealedAt)
      ? { outcome: "not_found" }
      : { outcome: "forbidden" };
  }
  return { outcome: "revealed", overlayUrl: overlayUrlFor(input.publicOrigin, envelope.token) };
};

export const getActiveOverlayAccessCount = (
  db: D1Database,
  channelId: string,
  overlayId: string,
  now: string,
): Promise<number> => countActiveOverlayAccesses(db, channelId, overlayId, now);

export const canManageOverlayAccesses = (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  now: string,
): Promise<boolean> => authorizeOverlayAccessManager(db, actor, channelId, now);

export const revokeOverlayAccess = (
  db: D1Database,
  channelId: string,
  overlayId: string,
  tokenId: string,
  actor: ActorContext,
  revokedAt: string,
): Promise<RevokeOverlayAccessResult> =>
  revokeStoredOverlayAccess(db, channelId, overlayId, tokenId, actor, revokedAt);

export const getOverlayAccessForReplacement = (
  db: D1Database,
  channelId: string,
  overlayId: string,
  tokenId: string,
  actor: ActorContext,
  now: string,
): Promise<OverlayAccessMetadata | null> =>
  getStoredOverlayAccessForReplacement(db, channelId, overlayId, tokenId, actor, now);

export const tokenEncryptionKeyRing = (environment: OverlayAccessEnvironment): string =>
  getTokenEncryptionKeys(environment);
