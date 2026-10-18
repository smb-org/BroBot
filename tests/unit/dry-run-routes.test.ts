import { describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "kanal-a";
const OPERATOR_ID = "operator-1";
const cookieKeys = JSON.stringify({ active: { id: "cookie-v1", key: Buffer.from(new Uint8Array(32).fill(1)).toString("base64url") }, retired: [] });
const encryptionKeys = JSON.stringify({ active: { id: "encryption-v1", key: Buffer.from(new Uint8Array(32).fill(2)).toString("base64url") }, retired: [] });

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  SESSION_COOKIE_KEYS: cookieKeys,
  SESSION_ENCRYPTION_KEYS: encryptionKeys,
  TOKEN_ENCRYPTION_KEYS: encryptionKeys,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  PUBLIC_ORIGIN: "https://brobot.example",
} as unknown as Env);

const requestFor = async (
  userId: string,
  body: unknown,
  channelId = CHANNEL_ID,
): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const [sessionCookie, csrfToken] = await Promise.all([
    createSessionCookie({ sessionId }, cookieKeys, encryptionKeys),
    createCsrfToken(sessionId, cookieKeys, new Date().toISOString()),
  ]);
  return new Request(`https://brobot.example/api/channels/${channelId}/dry-run`, {
    method: "POST",
    headers: {
      Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(body),
  });
};

const validRequest = {
  text: "!hello",
  sender: { login: "viewer_42", statuses: [] },
  streamState: "online",
  game: null,
  sharedChat: false,
};

describe("dry-run route", () => {
  it("rejects invalid strict payloads with the dry-run error code", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await insertLoginIdentityAndSession(database, OPERATOR_ID);
      await insertMember(database, CHANNEL_ID, OPERATOR_ID, "operator");
      const response = await panelRouter.fetch(await requestFor(OPERATOR_ID, { ...validRequest, extra: true }), environmentFor(database));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "dry_run_invalid" });
    } finally {
      database.close();
    }
  });

  it("allows an operator member and applies only-module filtering with no-store", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await insertLoginIdentityAndSession(database, OPERATOR_ID);
      await insertMember(database, CHANNEL_ID, OPERATOR_ID, "operator");
      const response = await panelRouter.fetch(await requestFor(OPERATOR_ID, {
        ...validRequest,
        only: { moduleId: "faq" },
      }), environmentFor(database));
      const result: unknown = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(result).toMatchObject({
        controls: { muted: false, paused: false },
        sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
        modules: [{ moduleId: "faq", status: "silent", entries: [] }],
      });
    } finally {
      database.close();
    }
  });

  it("rejects an operator who is a member of a different channel", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await insertChannel(database, "kanal-b");
      await insertLoginIdentityAndSession(database, OPERATOR_ID);
      await insertMember(database, CHANNEL_ID, OPERATOR_ID, "operator");
      const response = await panelRouter.fetch(await requestFor(OPERATOR_ID, validRequest, "kanal-b"), environmentFor(database));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "channel_access_denied" });
    } finally {
      database.close();
    }
  });
});
