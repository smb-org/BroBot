import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const NOW = "2026-09-18T04:00:00.000Z";

describe("channel control routes", () => {
  let database: TestD1Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  it("lets an operator enable and disable mute and pause with audited API writes", async () => {
    const channelId = "kanal-a";
    const userId = "operator-1";
    await insertChannel(database, channelId);
    await insertLoginIdentityAndSession(database, userId);
    await insertMember(database, channelId, userId, "operator");
    const cookie = await createSessionCookie(
      { sessionId: `session-${userId}` },
      keys.SESSION_COOKIE_KEYS,
      keys.SESSION_ENCRYPTION_KEYS,
    );
    const post = async (control: "mute" | "pause", duration: unknown): Promise<Response> => {
      const csrfToken = await createCsrfToken(`session-${userId}`, keys.SESSION_COOKIE_KEYS, NOW);
      return panelRouter.fetch(new Request(`https://brobot.example/api/channels/${channelId}/controls/${control}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrfToken}`,
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ duration }),
      }), {
        DB: database as unknown as D1Database,
        ...keys,
      });
    };

    const mute = await post("mute", "15m");
    expect(mute.status).toBe(200);
    await expect(mute.json()).resolves.toMatchObject({
      controls: { mute: { active: true, mode: "timed", until: "2026-09-18T04:15:00.000Z" } },
    });

    const pause = await post("pause", "until_stream_end");
    expect(pause.status).toBe(200);
    await expect(pause.json()).resolves.toMatchObject({
      controls: { pause: { active: false, pending: true, mode: "until_stream_end", until: null } },
    });

    const unpause = await post("pause", null);
    expect(unpause.status).toBe(200);
    await expect(unpause.json()).resolves.toMatchObject({
      controls: { pause: { active: false, mode: null, until: null } },
    });

    const unmute = await post("mute", null);
    expect(unmute.status).toBe(200);
    await expect(unmute.json()).resolves.toMatchObject({
      controls: { mute: { active: false, mode: null, until: null } },
    });
    const audit = await database.prepare(
      "SELECT actor_user_id, actor_kind, action FROM audit_log ORDER BY rowid",
    ).all<{ actor_user_id: string; actor_kind: string; action: string }>();
    expect(audit.results).toEqual([
      { actor_user_id: userId, actor_kind: "member", action: "channel.mute.enabled" },
      { actor_user_id: userId, actor_kind: "member", action: "channel.pause.enabled" },
      { actor_user_id: userId, actor_kind: "member", action: "channel.pause.disabled" },
      { actor_user_id: userId, actor_kind: "member", action: "channel.mute.disabled" },
    ]);
  });

  it("rejects an unrecognized duration with a closed API error", async () => {
    const channelId = "kanal-a";
    const userId = "operator-1";
    await insertChannel(database, channelId);
    await insertLoginIdentityAndSession(database, userId);
    await insertMember(database, channelId, userId, "operator");
    const cookie = await createSessionCookie(
      { sessionId: `session-${userId}` },
      keys.SESSION_COOKIE_KEYS,
      keys.SESSION_ENCRYPTION_KEYS,
    );
    const csrfToken = await createCsrfToken(`session-${userId}`, keys.SESSION_COOKIE_KEYS, NOW);
    const response = await panelRouter.fetch(new Request(`https://brobot.example/api/channels/${channelId}/controls/mute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrfToken}`,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ duration: "forever-ish" }),
    }), { DB: database as unknown as D1Database, ...keys });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "channel_control_input_invalid" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first())
      .resolves.toEqual({ count: 0 });
  });
});
