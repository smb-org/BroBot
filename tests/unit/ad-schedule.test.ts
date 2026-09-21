import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAdSchedule } from "../../src/worker/ad-schedule";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken } from "./fixtures";
import { TestD1Database } from "./test-d1";

const encryptionKeys = JSON.stringify({
  active: { id: "schedule-key", key: Buffer.from(new Uint8Array(32).fill(8)).toString("base64url") },
  retired: [],
});

describe("Twitch-Werbezeitplan", () => {
  let database: TestD1Database;
  let appTokenCiphertext: string;

  beforeEach(async () => {
    database = new TestD1Database();
    appTokenCiphertext = await encryptJson({ token: "app-token" }, parseKeyRing(encryptionKeys));
    await insertAppAccessToken(
      database,
      appTokenCiphertext,
      "2099-09-21T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    );
  });

  afterEach(() => { database.close(); });

  const environment = () => ({
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: encryptionKeys,
  } as unknown as Env);

  it("liest Zahlen als Zahlen und verwendet den App-Token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        next_ad_at: "2026-09-21T12:00:00Z",
        duration: 60,
        last_ad_at: "2026-09-21T11:00:00Z",
        preroll_free_time: 120,
        snooze_count: 2,
        snooze_refresh_at: "2026-09-21T11:30:00Z",
      }],
    }), { status: 200 }));

    await expect(getAdSchedule(environment(), "kanal-a", "2026-09-21T11:00:00.000Z", fetcher)).resolves.toEqual({
      fetched: true,
      reason: null,
      detail: { status: 200, message: null },
      schedule: {
        nextAdAt: "2026-09-21T12:00:00Z",
        duration: 60,
        lastAdAt: "2026-09-21T11:00:00Z",
        prerollFreeTime: 120,
        snoozeCount: 2,
        snoozeRefreshAt: "2026-09-21T11:30:00Z",
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.twitch.tv/helix/channels/ads?broadcaster_id=kanal-a",
      expect.objectContaining({
        headers: {
          "Client-ID": "client-id",
          Authorization: "Bearer app-token",
        },
      }),
    );
  });

  it("parst numerische Zeichenketten ebenso defensiv wie Zahlen", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        next_ad_at: "",
        duration: "60",
        last_ad_at: null,
        preroll_free_time: "120",
        snooze_count: "2",
        snooze_refresh_at: "",
      }],
    }), { status: 200 }));

    await expect(getAdSchedule(environment(), "kanal-a", "2026-09-21T11:00:00.000Z", fetcher)).resolves.toMatchObject({
      fetched: true,
      schedule: {
        nextAdAt: null,
        duration: 60,
        lastAdAt: null,
        prerollFreeTime: 120,
        snoozeCount: 2,
        snoozeRefreshAt: null,
      },
    });
  });

  it("liefert einen leeren Termin als erfolgreichen Normalfall", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{}] }), { status: 200 }));

    await expect(getAdSchedule(environment(), "kanal-a", "2026-09-21T11:00:00.000Z", fetcher)).resolves.toMatchObject({
      fetched: true,
      reason: null,
      schedule: {
        nextAdAt: null,
        duration: null,
        lastAdAt: null,
        prerollFreeTime: null,
        snoozeCount: null,
        snoozeRefreshAt: null,
      },
    });
  });

  it.each([
    [429, "rate_limited"],
    [401, "unauthorized"],
  ])("gibt HTTP %s als eigenen maschinenlesbaren Ausgang zurück", async (status, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "Twitch-Antwort" }),
      { status },
    ));

    await expect(getAdSchedule(environment(), "kanal-a", "2026-09-21T11:00:00.000Z", fetcher)).resolves.toEqual({
      fetched: false,
      reason,
      detail: { status, message: "Twitch-Antwort" },
      schedule: null,
    });
  });
});
