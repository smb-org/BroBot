import { Hono } from "hono";

import { hmacSha256, parseKeyRing } from "./auth/crypto";
import {
  recordEventSubRevocation,
  rememberEventSubMessage,
  type EventSubRevocationRecord,
} from "./auth/repository";

export const EVENTSUB_REPLAY_WINDOW_MS = 10 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeHex = (value: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/i.test(value)) return new Uint8Array(32);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

/** Vergleicht genau gleich lange Bytefolgen ohne Abbruch beim ersten Treffer. */
export const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

/**
 * Prüft eine Twitch-Signatur mit jedem Schlüssel des Rings. Auch nach einem
 * Treffer werden die übrigen Schlüssel geprüft, damit die Laufzeit nicht vom
 * aktiven Schlüssel abhängt.
 */
export const verifyEventSubSignature = async (
  messageId: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  serializedSecret: string,
): Promise<boolean> => {
  const ring = parseKeyRing(serializedSecret);
  const [algorithm, encodedSignature] = signature.split("=", 2);
  const signatureValue = encodedSignature ?? "";
  const validFormat = algorithm === "sha256" && /^[0-9a-f]{64}$/i.test(signatureValue);
  const expected = decodeHex(signatureValue);
  const payload = `${messageId}${timestamp}${rawBody}`;
  let matched = false;
  for (const entry of [ring.active, ...ring.retired]) {
    const digest = await hmacSha256(payload, entry);
    const equal = constantTimeEqual(digest, expected);
    matched = equal || matched;
  }
  return validFormat && matched;
};

/** Liest RFC3339 einschließlich der von Twitch verwendeten Nanosekunden. */
export const parseEventSubTimestamp = (value: string): number | null => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return null;
  const fraction = match[2] === undefined
    ? ""
    : `.${match[2].slice(1, 4).padEnd(3, "0")}`;
  const parsed = Date.parse(`${match[1] ?? ""}${fraction}${match[3] ?? ""}`);
  return Number.isFinite(parsed) ? parsed : null;
};

export const isEventSubTimestampFresh = (timestamp: string, nowMs: number): boolean => {
  const timestampMs = parseEventSubTimestamp(timestamp);
  return timestampMs !== null && nowMs - timestampMs <= EVENTSUB_REPLAY_WINDOW_MS;
};

const response = (body: BodyInit | null, status: number, contentType?: string): Response => {
  if (contentType === undefined) return new Response(body, { status });
  return new Response(body, { status, headers: { "Content-Type": contentType } });
};

const defer = async (
  context: { executionCtx: { waitUntil: (promise: Promise<unknown>) => void } },
  work: Promise<void>,
): Promise<void> => {
  try {
    context.executionCtx.waitUntil(work);
  } catch {
    // Hono-Unit-Tests haben keinen ExecutionContext; dort muss die Arbeit
    // synchron abgeschlossen werden, damit der Testzustand sichtbar bleibt.
    await work;
  }
};

const subscriptionRecord = (
  body: Record<string, unknown>,
  now: string,
): EventSubRevocationRecord | null => {
  const subscription = body.subscription;
  if (!isRecord(subscription) || typeof subscription.id !== "string" || subscription.id.length === 0 ||
      typeof subscription.type !== "string" || subscription.type.length === 0 ||
      typeof subscription.status !== "string" || subscription.status.length === 0 ||
      !isRecord(subscription.condition) ||
      typeof subscription.condition.broadcaster_user_id !== "string" ||
      subscription.condition.broadcaster_user_id.length === 0) return null;
  return {
    subscriptionId: subscription.id,
    channelId: subscription.condition.broadcaster_user_id,
    subscriptionType: subscription.type,
    status: "revoked",
    reason: subscription.status,
    revokedAt: now,
    updatedAt: now,
  };
};

export const eventSubRouter = new Hono<{ Bindings: Env }>();

eventSubRouter.post("/api/twitch/eventsub", async (context) => {
  const messageId = context.req.header("Twitch-Eventsub-Message-Id");
  const timestamp = context.req.header("Twitch-Eventsub-Message-Timestamp");
  const signature = context.req.header("Twitch-Eventsub-Message-Signature");
  if (messageId === undefined || messageId.length === 0 ||
      timestamp === undefined || signature === undefined) return response("Ungültige EventSub-Kopfzeilen.", 401);

  const rawBody = await context.req.text();
  const timestampMs = parseEventSubTimestamp(timestamp);
  if (timestampMs === null || !isEventSubTimestampFresh(timestamp, Date.now())) {
    return response("EventSub-Zeitstempel ist abgelaufen.", 403);
  }
  let validSignature: boolean;
  try {
    validSignature = await verifyEventSubSignature(
      messageId,
      timestamp,
      rawBody,
      signature,
      context.env.TWITCH_EVENTSUB_SECRET,
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) return response("Ungültige EventSub-Signatur.", 403);

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return response("Ungültiger EventSub-Nutzkörper.", 400);
  }
  if (!isRecord(body)) return response("Ungültiger EventSub-Nutzkörper.", 400);

  const messageType = context.req.header("Twitch-Eventsub-Message-Type");
  if (messageType === "webhook_callback_verification") {
    await rememberEventSubMessage(context.env.DB, messageId, new Date().toISOString());
    return typeof body.challenge === "string"
      ? response(body.challenge, 200, "text/plain; charset=UTF-8")
      : response("Challenge fehlt.", 400);
  }
  if (messageType !== "notification" && messageType !== "revocation") {
    return response("Unbekannter EventSub-Nachrichtentyp.", 400);
  }

  const now = new Date().toISOString();
  const revocation = messageType === "revocation" ? subscriptionRecord(body, now) : null;
  if (messageType === "revocation" && revocation === null) return response("Ungültiger Widerruf.", 400);

  const isNew = await rememberEventSubMessage(context.env.DB, messageId, now);
  if (!isNew) return response(null, 204);

  if (revocation !== null) {
    await defer(context, recordEventSubRevocation(context.env.DB, revocation));
  }
  return response(null, 204);
});
