import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hmacSha256, parseKeyRing } from "../../src/worker/auth/crypto";
import {
  eventSubRouter,
  isEventSubTimestampFresh,
  parseEventSubTimestamp,
} from "../../src/worker/eventsub";
import { scheduled } from "../../src/worker/scheduled";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string => Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url");
const secretRing = (activeByte: number, retiredByte?: number): string => JSON.stringify({
  active: { id: `active-${String(activeByte)}`, key: key(activeByte) },
  retired: retiredByte === undefined
    ? []
    : [{ id: `retired-${String(retiredByte)}`, key: key(retiredByte) }],
});

const hex = (bytes: Uint8Array): string => [...bytes]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const signedRequest = async (
  secret: string,
  messageType: string,
  body: string,
  messageId = "message-1",
  timestamp = "2026-09-19T10:00:00.123456789Z",
): Promise<Request> => {
  const ring = parseKeyRing(secret);
  const signature = hex(await hmacSha256(`${messageId}${timestamp}${body}`, ring.active));
  return new Request("https://brobot.example/api/twitch/eventsub", {
    method: "POST",
    body,
    headers: {
      "Twitch-Eventsub-Message-Id": messageId,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
      "Twitch-Eventsub-Message-Type": messageType,
    },
  });
};

describe("EventSub-Eingang", () => {
  let database: TestD1Database;
  const secret = secretRing(3);
  const environment = () => ({
    DB: database as unknown as D1Database,
    TWITCH_EVENTSUB_SECRET: secret,
  } as unknown as Env);

  beforeEach(() => {
    database = new TestD1Database();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  it("gibt eine gültige Verifizierungs-Challenge als Klartext zurück", async () => {
    const body = JSON.stringify({ challenge: "challenge-wert", subscription: {} });
    const response = await eventSubRouter.fetch(
      await signedRequest(secret, "webhook_callback_verification", body),
      environment(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-wert");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("lehnt eine Verifizierungsnachricht ohne Challenge ab", async () => {
    const body = JSON.stringify({ subscription: {} });
    const response = await eventSubRouter.fetch(
      await signedRequest(secret, "webhook_callback_verification", body, "message-no-challenge"),
      environment(),
    );

    expect(response.status).toBe(400);
  });

  it("prüft Signatur und Zeitstempel vor dem JSON-Körper", async () => {
    const request = new Request("https://brobot.example/api/twitch/eventsub", {
      method: "POST",
      body: "kein-json",
      headers: {
        "Twitch-Eventsub-Message-Id": "message-invalid",
        "Twitch-Eventsub-Message-Timestamp": "2026-09-19T10:00:00.000Z",
        "Twitch-Eventsub-Message-Signature": "sha256=" + "00".repeat(32),
        "Twitch-Eventsub-Message-Type": "notification",
      },
    });

    const response = await eventSubRouter.fetch(request, environment());

    expect(response.status).toBe(403);
    const row = await database.prepare("SELECT COUNT(*) AS count FROM eventsub_messages").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("weist Nachrichten ab, die älter als zehn Minuten sind", async () => {
    const timestamp = "2026-09-19T09:49:59.999999999Z";
    const body = JSON.stringify({ subscription: {}, event: {} });
    const response = await eventSubRouter.fetch(
      await signedRequest(secret, "notification", body, "message-old", timestamp),
      environment(),
    );

    expect(response.status).toBe(403);
  });

  it("akzeptiert einen ausgemusterten Signaturschlüssel", async () => {
    const ring = secretRing(3, 4);
    const body = JSON.stringify({ challenge: "rotations-challenge" });
    const timestamp = "2026-09-19T10:00:00.000Z";
    const retiredKey = parseKeyRing(ring).retired[0];
    if (retiredKey === undefined) throw new Error("Test-Schlüssel fehlt");
    const retiredSignature = hex(await hmacSha256(
      `message-retired${timestamp}${body}`,
      retiredKey,
    ));
    const request = new Request("https://brobot.example/api/twitch/eventsub", {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": "message-retired",
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": `sha256=${retiredSignature}`,
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
      },
    });

    const response = await eventSubRouter.fetch(request, {
      ...environment(),
      TWITCH_EVENTSUB_SECRET: ring,
    });

    expect(response.status).toBe(200);
  });

  it("verarbeitet dieselbe Message-ID nur einmal", async () => {
    await insertChannel(database, "channel-dedupe");
    const body = JSON.stringify({
      subscription: {
        id: "subscription-dedupe",
        type: "channel.chat.message",
        status: "authorization_revoked",
        condition: { broadcaster_user_id: "channel-dedupe" },
      },
    });
    const first = await eventSubRouter.fetch(
      await signedRequest(secret, "revocation", body),
      environment(),
    );
    const firstRow = await database.prepare(
      "SELECT updated_at FROM eventsub_revocations WHERE subscription_id = 'subscription-dedupe'",
    ).first<{ updated_at: string }>();
    vi.setSystemTime(new Date("2026-09-19T10:00:01.000Z"));
    const second = await eventSubRouter.fetch(
      await signedRequest(secret, "revocation", body),
      environment(),
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    const row = await database.prepare(
      "SELECT updated_at FROM eventsub_revocations WHERE subscription_id = 'subscription-dedupe'",
    ).first<{ updated_at: string }>();
    expect(row).toEqual(firstRow);
  });

  it("speichert einen Widerruf kanalgebunden für das spätere Panel", async () => {
    await insertChannel(database, "channel-42");
    const body = JSON.stringify({
      subscription: {
        id: "subscription-1",
        type: "channel.chat.message",
        status: "authorization_revoked",
        condition: { broadcaster_user_id: "channel-42" },
      },
    });
    const response = await eventSubRouter.fetch(
      await signedRequest(secret, "revocation", body, "message-revoked"),
      environment(),
    );

    expect(response.status).toBe(204);
    const row = await database.prepare(
      `SELECT subscription_id, channel_id, status, reason
         FROM eventsub_revocations`,
    ).first<Record<string, string>>();
    expect(row).toEqual({
      subscription_id: "subscription-1",
      channel_id: "channel-42",
      status: "revoked",
      reason: "authorization_revoked",
    });
  });

  it("parst Nanosekunden und lehnt ungültige Zeitstempel ab", () => {
    expect(parseEventSubTimestamp("2026-09-19T10:00:00.123456789Z")).toBe(
      Date.parse("2026-09-19T10:00:00.123Z"),
    );
    expect(parseEventSubTimestamp("2026-09-19 10:00:00Z")).toBeNull();
    expect(isEventSubTimestampFresh("2026-09-19T09:50:00.000Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(true);
    expect(isEventSubTimestampFresh("2026-09-19T09:49:59.999Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(false);
  });

  it("räumt alte Message-IDs im stündlichen Cron auf", async () => {
    await database.prepare(
      "INSERT INTO eventsub_messages (message_id, received_at) VALUES (?, ?), (?, ?)",
    ).bind(
      "old-message",
      "2026-09-18T09:59:59.999Z",
      "boundary-message",
      "2026-09-18T10:00:00.000Z",
    ).run();

    await scheduled(
      {} as ScheduledController,
      environment(),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    const rows = await database.prepare(
      "SELECT message_id FROM eventsub_messages ORDER BY message_id",
    ).all<{ message_id: string }>();
    expect(rows.results.map((row) => row.message_id)).toEqual(["boundary-message"]);
  });
});
