import { afterEach, describe, expect, it, vi } from "vitest";

import { werbungModul } from "../../src/modules/werbung";
import { listRequiredBroadcasterScopesForUser, moduleBroadcasterScopeState } from "../../src/worker/module-scopes";
import { upsertLoginIdentity, setLoginIdentityStatus } from "../../src/worker/auth/repository";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const asD1 = (database: TestD1Database): D1Database => database as unknown as D1Database;

const loginIdentity = (userId: string, scopes: string[], status: "connected" | "revoked" = "connected") => ({
  userId,
  login: userId,
  scopesJson: JSON.stringify(scopes),
  accessTokenCiphertext: `access-${userId}`,
  refreshTokenCiphertext: `refresh-${userId}`,
  expiresAt: "2099-09-19T00:00:00.000Z",
  status,
  reason: status === "revoked" ? "authorization_revoked" : null,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
} as const);

describe("Broadcaster-Scopes", () => {
  let database: TestD1Database;

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  it("vereinigt Login-Scopes und verliert sie bei einer kleineren späteren Antwort nicht", async () => {
    database = new TestD1Database();
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot", "channel:read:ads"]));
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot"]));

    await expect(database.prepare("SELECT scopes_json FROM twitch_login_identity WHERE user_id = 'user-1'").first())
      .resolves.toEqual({ scopes_json: '["channel:bot","channel:read:ads"]' });
  });

  it("leert die gespeicherten Scopes beim Widerruf", async () => {
    database = new TestD1Database();
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot", "channel:read:ads"]));
    await setLoginIdentityStatus(asD1(database), "user-1", "revoked", "authorization_revoked", "2026-09-20T10:00:00.000Z");

    await expect(database.prepare("SELECT status, scopes_json FROM twitch_login_identity WHERE user_id = 'user-1'").first())
      .resolves.toEqual({ status: "revoked", scopes_json: "[]" });
  });

  it("ermittelt die Autorisierung nur aus aktivierten Modulen eigener Broadcaster-Kanäle", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await insertMember(database, "kanal-b", "user-1", "verwalter");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'werbung', 1, '{}'), ('kanal-b', 'werbung', 1, '{}')",
    ).run();

    await expect(listRequiredBroadcasterScopesForUser(asD1(database), "user-1")).resolves.toEqual(["channel:read:ads"]);
  });

  it("meldet fehlende und vorhandene Modul-Scopes getrennt", async () => {
    database = new TestD1Database();
    await expect(moduleBroadcasterScopeState(asD1(database), "kanal-a", werbungModul)).resolves.toEqual({
      required: ["channel:read:ads"],
      missing: ["channel:read:ads"],
    });
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:read:ads"]);
    await expect(moduleBroadcasterScopeState(asD1(database), "kanal-a", werbungModul)).resolves.toEqual({
      required: ["channel:read:ads"],
      missing: [],
    });
  });
});
