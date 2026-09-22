import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthRepository from "../../src/worker/db/channel-members";

vi.mock("../../src/worker/db/channel-members", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthRepository>();
  return {
    ...actual,
    updateChannelMemberWithAudit: vi.fn().mockResolvedValue(true),
    deleteChannelMemberWithAudit: vi.fn().mockResolvedValue(true),
  };
});

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { memberRouter } from "../../src/worker/panel/member-routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

type MemberRole = "broadcaster" | "verwalter" | "bediener";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_BOT_LOGIN: "brobot",
  PUBLIC_ORIGIN: "https://brobot.example",
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (userId: string, path: string, method: "PATCH" | "DELETE", body?: object): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrfToken = await createCsrfToken(
    `session-${userId}`,
    environmentKeys.SESSION_COOKIE_KEYS,
    new Date().toISOString(),
  );
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  const init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://brobot.example${path}`, init);
};

const setupChannel = async (database: TestD1Database, actorRole: MemberRole): Promise<void> => {
  await insertChannel(database, "kanal-a");
  await insertLoginIdentityAndSession(database, "user-1");
  await insertMember(database, "kanal-a", "user-1", actorRole);
  await insertMember(database, "kanal-a", "user-2", "broadcaster");
  await insertMember(database, "kanal-a", "user-3", "broadcaster");
};

describe("Mitglieder-Handler: Broadcaster-Schwelle", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(() => {
    database = new TestD1Database();
    environment = environmentFor(database);
  });

  afterEach(() => {
    database.close();
  });

  it("weist einen Verwalter beim Herabstufen und Entfernen eines Broadcasters auch bei mehreren Broadcastern ab", async () => {
    await setupChannel(database, "verwalter");

    const changeResponse = await memberRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "verwalter" }),
      environment,
    );
    const removeResponse = await memberRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "DELETE"),
      environment,
    );

    expect(changeResponse.status).toBe(403);
    expect(removeResponse.status).toBe(403);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "broadcaster" });
  });
});
