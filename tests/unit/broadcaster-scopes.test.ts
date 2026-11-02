import { afterEach, describe, expect, it, vi } from "vitest";

import { adsModule } from "../../src/modules/ads";
import { tempVipsModule } from "../../src/modules/temp_vips";
import { LOGIN_SCOPES } from "../../src/worker/auth/oauth";
import {
  listAllBroadcasterScopes,
  listRequiredBroadcasterScopesForUser,
  moduleBroadcasterScopeState,
  moduleHasRequiredBroadcasterScopes,
  moduleOptionalBroadcasterScopeState,
  moduleOptionalBroadcasterScopes,
  VOLLUMFANG_BROADCASTER_SCOPES,
} from "../../src/worker/module-scopes";
import { getPanelModuleStates } from "../../src/worker/panel/module-repository";
import { broadcasterScopesForChannel } from "../../src/worker/broadcaster-scope";
import {
  upsertLoginIdentity,
  setLoginIdentityStatus,
} from "../../src/worker/db/login-identity";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const asD1 = (database: TestD1Database): D1Database => database as unknown as D1Database;

const loginIdentity = (userId: string, scopes: string[], status: "connected" | "revoked" = "connected") => ({
  userId,
  login: userId,
  scopesJson: JSON.stringify(scopes),
  tokenScopesJson: JSON.stringify(scopes),
  accessTokenCiphertext: `access-${userId}`,
  refreshTokenCiphertext: `refresh-${userId}`,
  expiresAt: "2099-09-19T00:00:00.000Z",
  status,
  reason: status === "revoked" ? "authorization_revoked" : null,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
} as const);

describe("broadcaster scopes", () => {
  let database: TestD1Database;

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  it("unions login scopes and doesn't lose them on a smaller later response", async () => {
    database = new TestD1Database();
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot", "channel:read:ads"]));
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot"]));

    await expect(database.prepare("SELECT scopes_json FROM twitch_login_identity WHERE user_id = 'user-1'").first())
      .resolves.toEqual({ scopes_json: '["channel:bot","channel:read:ads"]' });
  });

  it("replaces the token scopes on a smaller second login and keeps the granted union", async () => {
    database = new TestD1Database();
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot", "channel:read:ads"]));
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot"]));

    await expect(database.prepare(
      "SELECT scopes_json, token_scopes_json FROM twitch_login_identity WHERE user_id = 'user-1'",
    ).first()).resolves.toEqual({
      scopes_json: '["channel:bot","channel:read:ads"]',
      token_scopes_json: '["channel:bot"]',
    });
  });

  it("uses current token scopes for operational VIP readiness despite a broader history", async () => {
    database = new TestD1Database();
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot", "channel:manage:vips"]));
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot"]));

    await expect(broadcasterScopesForChannel(asD1(database), "user-1")).resolves.toEqual(["channel:bot"]);
    await expect(moduleOptionalBroadcasterScopeState(asD1(database), "user-1", tempVipsModule)).resolves.toEqual({
      optional: ["channel:manage:vips"],
      missingOptional: ["channel:manage:vips"],
    });
  });

  it("derives the full broadcaster scope from login, modules, and section 7", () => {
    database = new TestD1Database();
    expect(new Set(listAllBroadcasterScopes())).toEqual(new Set([
      ...LOGIN_SCOPES,
      ...VOLLUMFANG_BROADCASTER_SCOPES,
      "moderation:read",
    ]));
  });

  it("clears the stored scopes on revocation", async () => {
    database = new TestD1Database();
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot", "channel:read:ads"]));
    await setLoginIdentityStatus(asD1(database), "user-1", "revoked", "authorization_revoked", "2026-09-20T10:00:00.000Z");

    await expect(database.prepare("SELECT status, scopes_json FROM twitch_login_identity WHERE user_id = 'user-1'").first())
      .resolves.toEqual({ status: "revoked", scopes_json: "[]" });
  });

  it("also clears the token scopes on revocation", async () => {
    database = new TestD1Database();
    await upsertLoginIdentity(asD1(database), loginIdentity("user-1", ["channel:bot", "channel:read:ads"]));
    await setLoginIdentityStatus(asD1(database), "user-1", "revoked", "authorization_revoked", "2026-09-20T10:00:00.000Z");

    await expect(database.prepare(
      "SELECT scopes_json, token_scopes_json FROM twitch_login_identity WHERE user_id = 'user-1'",
    ).first()).resolves.toEqual({ scopes_json: "[]", token_scopes_json: "[]" });
  });

  it("determines authorization only from enabled modules of the user's own broadcaster channels", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-b", "kanal-a", "manager");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'ads', 1, '{}'), ('kanal-b', 'ads', 1, '{}')",
    ).run();

    await expect(listRequiredBroadcasterScopesForUser(asD1(database), "kanal-a")).resolves.toEqual(["channel:read:ads"]);
  });

  it("ignores a different channel's module despite the user's broadcaster role", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertMember(database, "kanal-b", "kanal-a", "broadcaster");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-b', 'ads', 1, '{}')",
    ).run();

    await expect(listRequiredBroadcasterScopesForUser(asD1(database), "kanal-a")).resolves.toEqual([]);
  });

  it("reports missing and present module scopes separately", async () => {
    database = new TestD1Database();
    await expect(moduleBroadcasterScopeState(asD1(database), "kanal-a", adsModule)).resolves.toEqual({
      required: ["channel:read:ads"],
      missing: ["channel:read:ads"],
    });
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:read:ads"]);
    await expect(moduleBroadcasterScopeState(asD1(database), "kanal-a", adsModule)).resolves.toEqual({
      required: ["channel:read:ads"],
      missing: [],
    });
  });

  it("flags channel:manage:ads on the ads module as an optional scope", () => {
    database = new TestD1Database();
    expect(moduleOptionalBroadcasterScopes(adsModule)).toEqual(["channel:manage:ads", "channel:edit:commercial"]);
  });

  it("keeps temporary VIP observation available without its managed-mode scope", () => {
    database = new TestD1Database();

    expect(moduleOptionalBroadcasterScopes(tempVipsModule)).toEqual(["channel:manage:vips"]);
    expect(moduleHasRequiredBroadcasterScopes(tempVipsModule, [])).toBe(true);
    expect(tempVipsModule.broadcasterScopes).toEqual([]);
  });

  it("publishes the VIP scope as optional panel metadata while keeping required scope state empty", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-vip-scope");
    await insertLoginIdentityAndSession(database, "kanal-vip-scope", []);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-vip-scope', 'temp_vips', 1, '{}')",
    ).run();

    const states = await getPanelModuleStates(asD1(database), "kanal-vip-scope");
    const state = states.find(({ id }) => id === "temp_vips");

    expect(state).toMatchObject({
      enabled: true,
      optionalBroadcasterScopes: ["channel:manage:vips"],
      missingOptionalBroadcasterScopes: ["channel:manage:vips"],
    });
    expect(state).not.toHaveProperty("requiredBroadcasterScopes");
    expect(state).not.toHaveProperty("missingBroadcasterScopes");
  });
});
