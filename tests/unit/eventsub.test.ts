import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EVENTSUB_MAX_BODY_BYTES,
  eventSubRouter,
  isEventSubTimestampFresh,
  parseEventSubTimestamp,
} from "../../src/worker/eventsub";
import { scheduled } from "../../src/worker/scheduled";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const key = (byte: number): string => Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url");
const secretRing = (activeByte: number, retiredByte?: number): string => JSON.stringify({
  active: { id: `active-${String(activeByte)}`, key: key(activeByte) },
  retired: retiredByte === undefined
    ? []
    : [{ id: `retired-${String(retiredByte)}`, key: key(retiredByte) }],
});
const encryptionKeys = secretRing(7);

const independentSignature = (
  secret: string,
  messageId: string,
  timestamp: string,
  body: string,
): string => createHmac("sha256", Buffer.from(secret, "ascii"))
  .update(Buffer.from(`${messageId}${timestamp}${body}`, "utf8"))
  .digest("hex");

/*
 * Unabhängiger Twitch-Testvektor, einmal offline mit
 * node:crypto/createHmac berechnet. Dieser Wert darf nicht aus
 * hmacSha256 stammen, weil der Test genau diesen Helfer gegen eine falsche
 * Interpretation von transport.secret absichern soll.
 */
const INDEPENDENT_VECTOR = {
  messageId: "message-independent",
  timestamp: "2026-09-19T10:00:00.000Z",
  body: JSON.stringify({ challenge: "unabhaengig" }),
  signature: "f78b937a255d0b796deb4f61761cea21febd1596d5faaca4916bd3f4b60d81ed",
};

const signedRequest = (
  secret: string,
  messageType: string,
  body: string,
  messageId = "message-1",
  timestamp = "2026-09-19T10:00:00.123456789Z",
): Request => {
  const ring = JSON.parse(secret) as { active: { key: string } };
  const signature = independentSignature(ring.active.key, messageId, timestamp, body);
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

const revocationBody = (channelId: string, subscriptionId: string): string => JSON.stringify({
  subscription: {
    id: subscriptionId,
    type: "channel.chat.message",
    status: "authorization_revoked",
    condition: { broadcaster_user_id: channelId },
  },
});

const failingBatchDatabase = (database: TestD1Database): D1Database => ({
  prepare: database.prepare.bind(database),
  batch: (statements: TestPreparedStatement[]) => {
    database.sqlite.exec("BEGIN");
    try {
      statements[0]?.runSync();
      throw new Error("simulierter Widerrufsspeicherfehler");
    } catch (error) {
      database.sqlite.exec("ROLLBACK");
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
} as unknown as D1Database);

describe("EventSub-Eingang", () => {
  let database: TestD1Database;
  const secret = secretRing(3);
  const environment = () => ({
    DB: database as unknown as D1Database,
    TWITCH_EVENTSUB_SECRET: secret,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: encryptionKeys,
  } as unknown as Env);

  beforeEach(() => {
    database = new TestD1Database();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("gibt eine gültige Verifizierungs-Challenge als Klartext zurück", async () => {
    const body = JSON.stringify({ challenge: "challenge-wert", subscription: {} });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "webhook_callback_verification", body),
      environment(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-wert");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("prüft einen unabhängig berechneten Twitch-Signaturvektor", async () => {
    const response = await eventSubRouter.fetch(
      new Request("https://brobot.example/api/twitch/eventsub", {
        method: "POST",
        body: INDEPENDENT_VECTOR.body,
        headers: {
          "Twitch-Eventsub-Message-Id": INDEPENDENT_VECTOR.messageId,
          "Twitch-Eventsub-Message-Timestamp": INDEPENDENT_VECTOR.timestamp,
          "Twitch-Eventsub-Message-Signature": `sha256=${INDEPENDENT_VECTOR.signature}`,
          "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        },
      }),
      environment(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("unabhaengig");
  });

  it("lehnt eine Verifizierungsnachricht ohne Challenge ab", async () => {
    const body = JSON.stringify({ subscription: {} });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "webhook_callback_verification", body, "message-no-challenge"),
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
    const timestamp = "2026-09-19T09:49:29.999999999Z";
    const body = JSON.stringify({ subscription: {}, event: {} });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "notification", body, "message-old", timestamp),
      environment(),
    );

    expect(response.status).toBe(403);
  });

  it("weist einen zu weit in der Zukunft liegenden Zeitstempel ab", async () => {
    const timestamp = "2026-09-19T10:10:30.001Z";
    const body = JSON.stringify({ challenge: "zukünftig" });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "webhook_callback_verification", body, "message-future", timestamp),
      environment(),
    );

    expect(response.status).toBe(403);
  });

  it("weist einen Nutzkörper oberhalb der harten Grenze vor dem JSON-Lesen ab", async () => {
    const body = new Uint8Array(EVENTSUB_MAX_BODY_BYTES + 1).fill(65);
    const response = await eventSubRouter.fetch(
      new Request("https://brobot.example/api/twitch/eventsub", {
        method: "POST",
        body,
        headers: {
          "Twitch-Eventsub-Message-Id": "message-too-large",
          "Twitch-Eventsub-Message-Timestamp": "2026-09-19T10:00:00.000Z",
          "Twitch-Eventsub-Message-Signature": `sha256=${"00".repeat(32)}`,
          "Twitch-Eventsub-Message-Type": "notification",
        },
      }),
      environment(),
    );

    expect(response.status).toBe(413);
    const row = await database.prepare("SELECT COUNT(*) AS count FROM eventsub_messages").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("prüft die Signatur über die empfangenen Rohbytes statt über dekodierten Text", async () => {
    const body = JSON.stringify({ challenge: "bom" });
    const bodyWithBom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(body),
    ]);
    const response = await eventSubRouter.fetch(
      new Request("https://brobot.example/api/twitch/eventsub", {
        method: "POST",
        body: bodyWithBom,
        headers: {
          "Twitch-Eventsub-Message-Id": "message-bom",
          "Twitch-Eventsub-Message-Timestamp": "2026-09-19T10:00:00.000Z",
          "Twitch-Eventsub-Message-Signature": "sha256=b5e8ddf2aaccf920dcf657538b2e1036910c7b22f616868071cba64e96e8bf3d",
          "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        },
      }),
      environment(),
    );

    expect(response.status).toBe(403);
  });

  it("akzeptiert einen ausgemusterten Signaturschlüssel", async () => {
    const ring = secretRing(3, 4);
    const body = JSON.stringify({ challenge: "rotations-challenge" });
    const timestamp = "2026-09-19T10:00:00.000Z";
    const retiredSignature = independentSignature(key(4), "message-retired", timestamp, body);
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
      signedRequest(secret, "revocation", body),
      environment(),
    );
    const firstRow = await database.prepare(
      "SELECT updated_at FROM eventsub_revocations WHERE subscription_id = 'subscription-dedupe'",
    ).first<{ updated_at: string }>();
    vi.setSystemTime(new Date("2026-09-19T10:00:01.000Z"));
    const second = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body),
      environment(),
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    const row = await database.prepare(
      "SELECT updated_at FROM eventsub_revocations WHERE subscription_id = 'subscription-dedupe'",
    ).first<{ updated_at: string }>();
    expect(row).toEqual(firstRow);
  });

  it("ordnet ein Raid trotz fremder Kanal-ID im Ereignisrumpf dem Abo-Kanal zu", async () => {
    await insertChannel(database, "channel-condition");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('channel-condition', 'kanalereignisse', 1, '{}')`,
    ).run();
    const body = JSON.stringify({
      subscription: {
        type: "channel.raid",
        condition: { to_broadcaster_user_id: "channel-condition" },
      },
      event: {
        from_broadcaster_user_id: "raid-source",
        from_broadcaster_user_name: "Quelle",
        to_broadcaster_user_id: "foreign-channel",
        to_broadcaster_user_name: "Fremd",
        viewers: 23,
      },
    });

    const response = await eventSubRouter.fetch(
      signedRequest(secret, "notification", body, "message-condition"),
      environment(),
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      `SELECT channel_id, module_id, code, detail_json
         FROM event_log`,
    ).first()).resolves.toEqual({
      channel_id: "channel-condition",
      module_id: "kanalereignisse",
      code: "kanalereignisse.raid.eingehend",
      detail_json: JSON.stringify({ quelle: "Quelle", zuschauer: 23 }),
    });
  });

  it("verbraucht bei einem fehlgeschlagenen Widerrufsspeichern die Message-ID nicht", async () => {
    await insertChannel(database, "channel-retry");
    const body = revocationBody("channel-retry", "subscription-retry");
    const first = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-retry"),
      { ...environment(), DB: failingBatchDatabase(database) },
    );

    expect(first.status).toBe(500);
    const afterFailure = await database.prepare(
      "SELECT COUNT(*) AS count FROM eventsub_messages",
    ).first<{ count: number }>();
    expect(afterFailure?.count).toBe(0);

    const second = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-retry"),
      environment(),
    );

    expect(second.status).toBe(204);
    await expect(database.prepare(
      "SELECT subscription_id FROM eventsub_revocations WHERE subscription_id = 'subscription-retry'",
    ).first()).resolves.toEqual({ subscription_id: "subscription-retry" });
  });

  it("speichert einen Widerruf kanalgebunden für das spätere Panel", async () => {
    await insertChannel(database, "channel-42");
    await insertLoginIdentityAndSession(database, "channel-42", ["channel:bot"]);
    const body = JSON.stringify({
      subscription: {
        id: "subscription-1",
        type: "channel.chat.message",
        status: "authorization_revoked",
        condition: { broadcaster_user_id: "channel-42" },
      },
    });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-revoked"),
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
    await expect(database.prepare(
      `SELECT channel_id, subscription_type, subscription_id, status, reason
         FROM eventsub_subscriptions`,
    ).first()).resolves.toEqual({
      channel_id: "channel-42",
      subscription_type: "channel.chat.message",
      subscription_id: "subscription-1",
      status: "revoked",
      reason: "authorization_revoked",
    });
    await expect(database.prepare(
      "SELECT status, reason FROM twitch_login_identity WHERE user_id = 'channel-42'",
    ).first()).resolves.toEqual({ status: "revoked", reason: "authorization_revoked" });
  });

  it("gewinnt den Kanal eines Shoutout-Widerrufs über die gemeinsame Bedingungsdefinition zurück", async () => {
    await insertChannel(database, "channel-shoutout");
    const body = JSON.stringify({
      subscription: {
        id: "shoutout-subscription",
        type: "channel.shoutout.create",
        status: "authorization_revoked",
        condition: { broadcaster_user_id: "channel-shoutout", moderator_user_id: "bot-user" },
      },
    });

    const response = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-shoutout-revoked"),
      environment(),
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      "SELECT channel_id, subscription_type, subscription_id FROM eventsub_revocations",
    ).first()).resolves.toEqual({
      channel_id: "channel-shoutout",
      subscription_type: "channel.shoutout.create",
      subscription_id: "shoutout-subscription",
    });
    await expect(database.prepare(
      "SELECT channel_id, subscription_type, variant, subscription_id, status, reason FROM eventsub_subscriptions",
    ).first()).resolves.toEqual({
      channel_id: "channel-shoutout",
      subscription_type: "channel.shoutout.create",
      variant: "",
      subscription_id: "shoutout-subscription",
      status: "revoked",
      reason: "authorization_revoked",
    });
  });

  it("bewahrt einen Widerruf für einen unbekannten Kanal sichtbar auf", async () => {
    const body = revocationBody("channel-unknown", "subscription-unknown");
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-unknown"),
      environment(),
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      "SELECT subscription_id, channel_id, status FROM eventsub_revocations WHERE subscription_id = 'subscription-unknown'",
    ).first()).resolves.toEqual({
      subscription_id: "subscription-unknown",
      channel_id: "channel-unknown",
      status: "revoked",
    });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channels WHERE channel_id = 'channel-unknown'",
    ).first()).resolves.toEqual({ count: 0 });
  });

  it("parst Nanosekunden und lehnt ungültige Zeitstempel ab", () => {
    expect(parseEventSubTimestamp("2026-09-19T10:00:00.123456789Z")).toBe(
      Date.parse("2026-09-19T10:00:00.123Z"),
    );
    expect(parseEventSubTimestamp("2026-09-19 10:00:00Z")).toBeNull();
    expect(isEventSubTimestampFresh("2026-09-19T09:50:00.000Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(true);
    expect(isEventSubTimestampFresh("2026-09-19T09:49:29.999Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(false);
    expect(isEventSubTimestampFresh("2026-09-19T10:10:30.000Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(true);
    expect(isEventSubTimestampFresh("2026-09-19T10:10:30.001Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(false);
  });

  it("wendet die EventSub-Migration idempotent erneut an", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../../migrations/0008_eventsub_eingang.sql"),
      "utf8",
    );

    expect(() => {
      database.sqlite.exec(migration);
    }).not.toThrow();
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

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "scheduled-token", expires_in: 7200 }),
      { status: 200 },
    )));

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
