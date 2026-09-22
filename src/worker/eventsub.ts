import { Hono } from "hono";

import { hmacSha256, parseKeyRing } from "./auth/crypto";
import { confirmBotIdentityAuthorization } from "./bot-maintenance";
import { confirmLoginIdentityAuthorization } from "./login-maintenance";
import { dispatchEventSubNotification } from "./dispatch";
import { aktualisiereWerbevorwarnung, isWerbevorwarnungsAnlass } from "./werbe-vorwarnung";
import { eventSubDefinitionForCondition } from "./eventsub-subscriptions";
import type { EventSubSubscriptionType } from "../contracts/values";
import {
  hasEventSubMessage,
  rememberEventSubMessageAndRevocation,
  rememberEventSubMessage,
  type EventSubRevocationRecord,
} from "./db/eventsub-state";

export {
  fetchEventSubSubscriptions,
  listDesiredEventSubTargets,
  maintainEventSubSubscriptions,
  reconcileEventSubSubscriptions,
} from "./eventsub-subscriptions";

export const EVENTSUB_REPLAY_WINDOW_MS = 10 * 60 * 1000;
/** Retain twice the replay window: the second window is a clock-skew reserve. */
export const EVENTSUB_REPLAY_RETENTION_FACTOR = 2;
export const eventSubMessageCutoff = (
  now: string,
  replayWindowMs: number = EVENTSUB_REPLAY_WINDOW_MS,
): string => new Date(
  Date.parse(now) - replayWindowMs * EVENTSUB_REPLAY_RETENTION_FACTOR,
).toISOString();
// Twitch-Nutzkörper sind klein; 64 KiB lässt viel Reserve für Metadaten und
// verhindert trotzdem, dass der unauthentifizierte Eingang beliebig wächst.
export const EVENTSUB_MAX_BODY_BYTES = 64 * 1024;
export const EVENTSUB_TIMESTAMP_SKEW_TOLERANCE_MS = 30 * 1000;

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
  rawBody: Uint8Array,
  signature: string,
  serializedSecret: string,
): Promise<boolean> => {
  const ring = parseKeyRing(serializedSecret);
  const [algorithm, encodedSignature] = signature.split("=", 2);
  const signatureValue = encodedSignature ?? "";
  const validFormat = algorithm === "sha256" && /^[0-9a-f]{64}$/i.test(signatureValue);
  const expected = decodeHex(signatureValue);
  const prefix = new TextEncoder().encode(`${messageId}${timestamp}`);
  const payload = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  payload.set(prefix);
  payload.set(rawBody, prefix.byteLength);
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
  return timestampMs !== null &&
    Math.abs(nowMs - timestampMs) <= EVENTSUB_REPLAY_WINDOW_MS + EVENTSUB_TIMESTAMP_SKEW_TOLERANCE_MS;
};

const response = (body: BodyInit | null, status: number, contentType?: string): Response => {
  if (contentType === undefined) return new Response(body, { status });
  return new Response(body, { status, headers: { "Content-Type": contentType } });
};

const readEventSubBody = async (request: Request): Promise<Uint8Array | null> => {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > EVENTSUB_MAX_BODY_BYTES) {
      return null;
    }
  }

  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      totalLength += value.byteLength;
      if (totalLength > EVENTSUB_MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const decodeEventSubBody = (body: Uint8Array): string => new TextDecoder().decode(body);

const subscriptionRecord = (
  body: Record<string, unknown>,
  now: string,
): EventSubRevocationRecord | null => {
  const subscription = body.subscription;
  if (!isRecord(subscription) || typeof subscription.id !== "string" || subscription.id.length === 0 ||
      typeof subscription.type !== "string" || subscription.type.length === 0 ||
      typeof subscription.status !== "string" || subscription.status.length === 0 ||
      !isRecord(subscription.condition)) return null;
  const definition = eventSubDefinitionForCondition(subscription.type, subscription.condition);
  const channelId = definition?.channelIdFromCondition(subscription.condition) ?? null;
  if (definition === null || channelId === null) return null;
  return {
    subscriptionId: subscription.id,
    channelId,
    subscriptionType: definition.subscriptionType,
    variant: definition.variant,
    version: typeof subscription.version === "string" && subscription.version.length > 0 ? subscription.version : "1",
    status: "revoked",
    reason: subscription.status,
    revokedAt: now,
    updatedAt: now,
    authorizationIdentity: definition.consentingIdentityFromCondition(subscription.condition),
  };
};

/**
 * Liest Kanal und Abo-Typ aus der geprüften Benachrichtigung. Der Kanal kommt
 * ausschließlich aus der Bedingung des Abos und nie aus dem Ereignisrumpf —
 * sonst könnte ein fremder Kanal in unseren hineinschreiben.
 */
const notificationZiel = (body: Record<string, unknown>): {
  channelId: string;
  subscriptionType: EventSubSubscriptionType;
  subscriptionVariant: string;
  payload: Readonly<Record<string, unknown>>;
} | null => {
  const subscription = body.subscription;
  if (!isRecord(subscription)) return null;
  const condition = subscription.condition;
  if (!isRecord(condition)) return null;
  const subscriptionType = subscription.type;
  if (typeof subscriptionType !== "string" || subscriptionType.length === 0) return null;
  const definition = eventSubDefinitionForCondition(subscriptionType, condition);
  const channelId = definition?.channelIdFromCondition(condition) ?? null;
  if (definition === null || channelId === null) return null;
  return {
    channelId,
    subscriptionType: definition.subscriptionType,
    subscriptionVariant: definition.variant,
    payload: isRecord(body.event) ? body.event : {},
  };
};

const confirmRevocationAuthorization = async (
  env: Env,
  revocation: EventSubRevocationRecord,
  now: string,
): Promise<boolean> => {
  if (revocation.reason !== "authorization_revoked" || revocation.authorizationIdentity === null ||
      revocation.authorizationIdentity === undefined) return false;
  if (revocation.authorizationIdentity.kind === "bot") {
    return confirmBotIdentityAuthorization(env, revocation.authorizationIdentity.userId, now);
  }
  return confirmLoginIdentityAuthorization(env, revocation.authorizationIdentity.userId, now);
};

export const eventSubRouter = new Hono<{ Bindings: Env }>();

eventSubRouter.post("/api/twitch/eventsub", async (context) => {
  const messageId = context.req.header("Twitch-Eventsub-Message-Id");
  const timestamp = context.req.header("Twitch-Eventsub-Message-Timestamp");
  const signature = context.req.header("Twitch-Eventsub-Message-Signature");
  if (messageId === undefined || messageId.length === 0 ||
      timestamp === undefined || signature === undefined) return response("Ungültige EventSub-Kopfzeilen.", 401);

  const rawBody = await readEventSubBody(context.req.raw);
  if (rawBody === null) return response("EventSub-Nutzkörper ist zu groß.", 413);
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
  const decodedBody = decodeEventSubBody(rawBody);
  try {
    body = JSON.parse(decodedBody) as unknown;
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

  if (revocation !== null) {
    if (await hasEventSubMessage(context.env.DB, messageId)) return response(null, 204);
    const authorizationConfirmedRevoked = await confirmRevocationAuthorization(context.env, revocation, now);
    const isNew = await rememberEventSubMessageAndRevocation(
      context.env.DB,
      messageId,
      now,
      revocation,
      authorizationConfirmedRevoked,
    );
    if (!isNew) return response(null, 204);
    return response(null, 204);
  }

  const isNew = await rememberEventSubMessage(context.env.DB, messageId, now);
  if (!isNew) return response(null, 204);

  const ziel = notificationZiel(body);
  if (ziel === null) return response("Ungültige EventSub-Benachrichtigung.", 400);

  // Bewusst abgewartet statt im Hintergrund: Ein Chat-Aufruf ist kurz, und so
  // ist der Ausgang in Tests sichtbar. Sollte die Verteilung später länger
  // dauern, gehört sie hinter die Antwort.
  await dispatchEventSubNotification(context.env, {
    channelId: ziel.channelId,
    subscriptionType: ziel.subscriptionType,
    subscriptionVariant: ziel.subscriptionVariant,
    triggerId: messageId,
    payload: ziel.payload,
    receivedAt: now,
  });
  if (isWerbevorwarnungsAnlass(ziel.subscriptionType)) {
    try {
      await aktualisiereWerbevorwarnung(context.env, ziel.channelId, messageId, now);
    } catch (error: unknown) {
      console.error("Werbe-Vorwarnung konnte nicht aktualisiert werden.", error);
    }
  }
  return response(null, 204);
});
