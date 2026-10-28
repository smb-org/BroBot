import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { BOT_SCOPES, missingBotScopes } from "../../src/worker/auth/oauth";
import { maintainBotIdentity } from "../../src/worker/bot-maintenance";
import { maintainLoginIdentities } from "../../src/worker/login-maintenance";
import { setBotChannelStatus } from "../../src/worker/db/bot-channel-status";
import {
  setBotIdentityMissingScopesIfCurrent,
  setBotIdentityStatus,
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { upsertEventSubSubscription } from "../../src/worker/db/eventsub-state";
import {
  acquireLoginIdentityRefreshLease,
  releaseLoginIdentityRefreshLease,
  setLoginIdentityStatusIfCurrent,
  setLoginIdentityTokenScopes,
  upsertLoginIdentity,
} from "../../src/worker/db/login-identity";
import { refreshHelixStreamState, writeHelixStreamStateIfUnknown } from "../../src/worker/db/stream-state";
import { purgeOldEventLogEntries } from "../../src/worker/event-log";
import { createInitialAlertState } from "../../src/modules/belabox/domain/alert";
import { prepareBelaboxHistoryFinalizers, writeBelaboxFetch } from "../../src/modules/belabox/adapters/d1";
import { insertChannel, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

interface PanelRevisionState {
  resources: Array<{ channel_id: string; resource: string; revision: number }>;
  globals: Array<{ resource: string; revision: number }>;
  pending: Array<{ channel_id: string; resource: string; revision: number }>;
}

const readPanelRevisionState = (database: TestD1Database): PanelRevisionState => ({
  resources: database.sqlite.prepare(
    "SELECT channel_id, resource, revision FROM panel_resource_revisions ORDER BY channel_id, resource",
  ).all() as PanelRevisionState["resources"],
  globals: database.sqlite.prepare(
    "SELECT resource, revision FROM panel_global_resource_revisions ORDER BY resource",
  ).all() as PanelRevisionState["globals"],
  pending: database.sqlite.prepare(
    "SELECT channel_id, resource, revision FROM panel_resource_pending ORDER BY channel_id, resource",
  ).all() as PanelRevisionState["pending"],
});

const totalChanges = (database: TestD1Database): number =>
  (database.sqlite.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;

const resourceRevision = (state: PanelRevisionState, channelId: string, resource: string): number =>
  state.resources.find((row) => row.channel_id === channelId && row.resource === resource)?.revision ?? 0;

const globalRevision = (state: PanelRevisionState, resource: string): number =>
  state.globals.find((row) => row.resource === resource)?.revision ?? 0;

const seedBotIdentity = async (
  database: TestD1Database,
  status: "connected" | "revoked" = "connected",
): Promise<void> => {
  const db = database as unknown as D1Database;
  await upsertBotIdentity(db, {
    id: 1,
    userId: "bot-user",
    login: "brobot",
    scopesJson: JSON.stringify(BOT_SCOPES),
    accessTokenCiphertext: "access-token-ciphertext",
    refreshTokenCiphertext: "refresh-token-ciphertext",
    expiresAt: "2099-09-18T00:00:00.000Z",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  });
  await database.prepare(
    "UPDATE bot_identity SET missing_scopes_json = ? WHERE id = 1",
  ).bind(JSON.stringify(missingBotScopes(BOT_SCOPES))).run();
  await setBotIdentityStatus(db, status, status === "revoked" ? "authorization_revoked" : null, "2026-09-18T00:00:00.000Z");
};

describe("D1 no-op writes and panel revisions", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("does not write or revise panel resources during unchanged revoked bot maintenance", async () => {
    await insertChannel(database, "bot-noop");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('bot-noop', 'chat', 1, '{}')",
    ).run();
    await seedBotIdentity(database, "revoked");
    await database.prepare("DELETE FROM panel_resource_pending").run();
    const beforeChanges = totalChanges(database);
    const beforeRevisions = readPanelRevisionState(database);

    await maintainBotIdentity({ DB: database as unknown as D1Database } as Env, "2026-09-19T00:00:00.000Z");

    expect(totalChanges(database) - beforeChanges).toBe(0);
    expect(readPanelRevisionState(database)).toEqual(beforeRevisions);
  });

  it("revises panel resources when missing bot scopes change", async () => {
    await insertChannel(database, "bot-scopes");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('bot-scopes', 'chat', 1, '{}')",
    ).run();
    await seedBotIdentity(database);
    await database.prepare("DELETE FROM panel_resource_pending").run();
    const before = readPanelRevisionState(database);
    const changed = await setBotIdentityMissingScopesIfCurrent(
      database as unknown as D1Database,
      ["moderator:read:chatters"],
      "access-token-ciphertext",
      "refresh-token-ciphertext",
    );
    const after = readPanelRevisionState(database);

    expect(changed).toBe(true);
    expect(resourceRevision(after, "bot-scopes", "channel.overview")).toBe(
      resourceRevision(before, "bot-scopes", "channel.overview") + 1,
    );
    expect(resourceRevision(after, "bot-scopes", "module:chat:settings")).toBe(
      resourceRevision(before, "bot-scopes", "module:chat:settings") + 1,
    );
    expect(globalRevision(after, "channels")).toBe(globalRevision(before, "channels") + 1);
  });

  it("does not write or revise an unchanged EventSub subscription upsert", async () => {
    await insertChannel(database, "eventsub-noop");
    const db = database as unknown as D1Database;
    const subscription = {
      channelId: "eventsub-noop",
      subscriptionType: "channel.chat.message" as const,
      variant: "",
      version: "1",
      subscriptionId: "subscription-1",
      secretId: null,
      status: "enabled" as const,
      reason: null,
      errorMessage: null,
      errorStatus: null,
      updatedAt: "2026-09-18T00:00:00.000Z",
    };
    await upsertEventSubSubscription(db, subscription);
    const beforeChanges = totalChanges(database);
    const beforeRevisions = readPanelRevisionState(database);

    await upsertEventSubSubscription(db, { ...subscription, updatedAt: "2026-09-19T00:00:00.000Z" });

    expect(totalChanges(database) - beforeChanges).toBe(0);
    expect(readPanelRevisionState(database)).toEqual(beforeRevisions);
    const row = database.sqlite.prepare(
      "SELECT updated_at FROM eventsub_subscriptions WHERE channel_id = 'eventsub-noop'",
    ).get() as { updated_at: string };
    expect(row.updated_at).toBe(subscription.updatedAt);
  });

  it("revises panel resources when an EventSub subscription field changes", async () => {
    await insertChannel(database, "eventsub-change");
    const db = database as unknown as D1Database;
    const subscription = {
      channelId: "eventsub-change",
      subscriptionType: "channel.chat.message" as const,
      variant: "",
      version: "1",
      subscriptionId: "subscription-1",
      secretId: null,
      status: "enabled" as const,
      reason: null,
      errorMessage: null,
      errorStatus: null,
      updatedAt: "2026-09-18T00:00:00.000Z",
    };
    await upsertEventSubSubscription(db, subscription);
    const before = readPanelRevisionState(database);

    await upsertEventSubSubscription(db, {
      ...subscription,
      status: "error",
      reason: "subscription_failed",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });

    const after = readPanelRevisionState(database);
    expect(resourceRevision(after, "eventsub-change", "channel.overview")).toBe(
      resourceRevision(before, "eventsub-change", "channel.overview") + 1,
    );
    expect(globalRevision(after, "channels")).toBe(globalRevision(before, "channels") + 1);
  });

  it("revises panel resources when bot identity status changes", async () => {
    await insertChannel(database, "bot-status-change");
    await seedBotIdentity(database);
    await database.prepare("DELETE FROM panel_resource_pending").run();
    const before = readPanelRevisionState(database);

    await setBotIdentityStatus(
      database as unknown as D1Database,
      "error",
      "validation_failed",
      "2026-09-19T00:00:00.000Z",
    );

    const after = readPanelRevisionState(database);
    expect(resourceRevision(after, "bot-status-change", "channel.overview")).toBe(
      resourceRevision(before, "bot-status-change", "channel.overview") + 1,
    );
    expect(globalRevision(after, "channels")).toBe(globalRevision(before, "channels") + 1);
  });

  it("keeps global bot health heartbeats out of channel revisions", async () => {
    await insertChannel(database, "bookkeeping-only");
    await insertChannel(database, "bookkeeping-other");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('bookkeeping-only', 'chat', 1, '{}')",
    ).run();
    await seedBotIdentity(database);
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, variant, version, subscription_id, status, updated_at)
       VALUES ('bookkeeping-only', 'channel.chat.message', '', '1', 'subscription-1', 'enabled', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare("DELETE FROM panel_resource_pending").run();
    const before = readPanelRevisionState(database);

    // bot_identity.updated_at is not read by the panel: still no bump.
    await database.prepare("UPDATE bot_identity SET updated_at = '2026-09-19T00:00:00.000Z' WHERE id = 1").run();
    expect(readPanelRevisionState(database)).toEqual(before);

    await database.prepare("UPDATE bot_identity_status SET updated_at = '2026-09-19T00:00:00.000Z' WHERE id = 1").run();
    const afterStatus = readPanelRevisionState(database);
    expect(resourceRevision(afterStatus, "bookkeeping-only", "channel.overview")).toBe(
      resourceRevision(before, "bookkeeping-only", "channel.overview"),
    );
    expect(afterStatus.resources.filter(({ channel_id }) => channel_id === "bookkeeping-other")).toEqual(
      before.resources.filter(({ channel_id }) => channel_id === "bookkeeping-other"),
    );
    expect(afterStatus.pending.filter(({ channel_id }) => channel_id === "bookkeeping-other")).toEqual(
      before.pending.filter(({ channel_id }) => channel_id === "bookkeeping-other"),
    );
    expect(globalRevision(afterStatus, "channels")).toBe(globalRevision(before, "channels"));
    expect(globalRevision(afterStatus, "bot.identity.status")).toBe(globalRevision(before, "bot.identity.status") + 1);

    await database.prepare("UPDATE eventsub_subscriptions SET updated_at = '2026-09-19T00:00:00.000Z' WHERE channel_id = 'bookkeeping-only'").run();
    const afterSubscription = readPanelRevisionState(database);
    expect(resourceRevision(afterSubscription, "bookkeeping-only", "channel.overview")).toBe(
      resourceRevision(afterStatus, "bookkeeping-only", "channel.overview") + 1,
    );
    expect(globalRevision(afterSubscription, "channels")).toBe(globalRevision(afterStatus, "channels") + 1);
  });

  it("does not revise member channels for unchanged login scopes, status, or token leases", async () => {
    await insertChannel(database, "login-owner");
    await insertChannel(database, "login-other");
    await insertMember(database, "login-owner", "login-user", "manager");
    await insertMember(database, "login-other", "login-user", "operator");
    const db = database as unknown as D1Database;
    await upsertLoginIdentity(db, {
      userId: "login-user",
      login: "login-user",
      scopesJson: '["user:read:moderated_channels"]',
      tokenScopesJson: '["user:read:moderated_channels"]',
      accessTokenCiphertext: "login-access",
      refreshTokenCiphertext: "login-refresh",
      expiresAt: "2099-09-18T00:00:00.000Z",
      status: "connected",
      reason: null,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    const before = readPanelRevisionState(database);

    await setLoginIdentityTokenScopes(db, "login-user", '["user:read:moderated_channels"]', "2026-09-19T00:00:00.000Z");
    await setLoginIdentityStatusIfCurrent(
      db,
      "login-user",
      "connected",
      null,
      "2026-09-19T00:00:00.000Z",
      "login-access",
      "login-refresh",
    );
    await acquireLoginIdentityRefreshLease(db, "login-user", "login-access", "login-refresh", "lease-owner", 2_000, 1_000);
    await releaseLoginIdentityRefreshLease(db, "login-user", "lease-owner");

    const after = readPanelRevisionState(database);
    expect(after.resources).toEqual(before.resources);
    expect(after.pending).toEqual(before.pending);
    expect(after.globals).toEqual(before.globals);
    await expect(database.prepare(
      "SELECT updated_at FROM twitch_login_identity WHERE user_id = 'login-user'",
    ).first()).resolves.toEqual({ updated_at: "2026-09-18T00:00:00.000Z" });
  });

  it("does not write or revise member channels during an unchanged login maintenance run", async () => {
    await insertChannel(database, "login-maintenance-owner");
    await insertChannel(database, "login-maintenance-other");
    await insertMember(database, "login-maintenance-owner", "login-maintenance-user", "manager");
    await insertMember(database, "login-maintenance-other", "login-maintenance-user", "operator");
    const encryptionKeys = parseKeyRing(JSON.stringify({
      active: { id: "test-key", key: Buffer.from(new Uint8Array(32).fill(9)).toString("base64url") },
      retired: [],
    }));
    const accessTokenCiphertext = await encryptJson({ token: "access-token" }, encryptionKeys);
    const refreshTokenCiphertext = await encryptJson({ token: "refresh-token" }, encryptionKeys);
    const db = database as unknown as D1Database;
    await upsertLoginIdentity(db, {
      userId: "login-maintenance-user",
      login: "login-maintenance-user",
      scopesJson: '["channel:read:ads"]',
      tokenScopesJson: '["channel:read:ads"]',
      accessTokenCiphertext,
      refreshTokenCiphertext,
      expiresAt: "2099-09-18T00:00:00.000Z",
      status: "connected",
      reason: null,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare(
      `INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at)
       VALUES ('login-maintenance-session', 'login-maintenance-user', 'login-maintenance-user',
         '2099-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user_id: "login-maintenance-user",
      login: "login-maintenance-user",
      expires_in: 7_200,
      scopes: ["channel:read:ads"],
    }), { status: 200 })));
    const beforeChanges = totalChanges(database);
    const before = readPanelRevisionState(database);

    await maintainLoginIdentities({
      DB: db,
      TWITCH_CLIENT_ID: "client-id",
      TWITCH_CLIENT_SECRET: "client-secret",
      SESSION_ENCRYPTION_KEYS: JSON.stringify({
        active: { id: "test-key", key: Buffer.from(new Uint8Array(32).fill(9)).toString("base64url") },
        retired: [],
      }),
    } as unknown as Env, "2026-09-19T00:00:00.000Z");

    expect(readPanelRevisionState(database)).toEqual(before);
    expect(totalChanges(database) - beforeChanges).toBe(0);
  });

  it("revises member channels when a login token scope changes", async () => {
    await insertChannel(database, "login-change-owner");
    await insertChannel(database, "login-change-other");
    await insertMember(database, "login-change-owner", "login-change-user", "manager");
    await insertMember(database, "login-change-other", "login-change-user", "operator");
    const db = database as unknown as D1Database;
    await upsertLoginIdentity(db, {
      userId: "login-change-user",
      login: "login-change-user",
      scopesJson: "[]",
      tokenScopesJson: "[]",
      accessTokenCiphertext: "login-access",
      refreshTokenCiphertext: "login-refresh",
      expiresAt: "2099-09-18T00:00:00.000Z",
      status: "connected",
      reason: null,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    const before = readPanelRevisionState(database);

    await setLoginIdentityTokenScopes(db, "login-change-user", '["channel:read:ads"]', "2026-09-19T00:00:00.000Z");

    const after = readPanelRevisionState(database);
    for (const channelId of ["login-change-owner", "login-change-other"]) {
      expect(resourceRevision(after, channelId, "channel.members")).toBe(
        resourceRevision(before, channelId, "channel.members") + 1,
      );
    }
    expect(globalRevision(after, "channels")).toBe(globalRevision(before, "channels") + 1);
  });

  it("revises only the checked channel for a moderator heartbeat", async () => {
    await insertChannel(database, "moderator-checked");
    await insertChannel(database, "moderator-other");
    const db = database as unknown as D1Database;
    await setBotChannelStatus(db, "moderator-checked", true, "2026-09-18T00:00:00.000Z", null);
    const before = readPanelRevisionState(database);

    await setBotChannelStatus(db, "moderator-checked", true, "2026-09-19T00:00:00.000Z", null);

    const after = readPanelRevisionState(database);
    expect(resourceRevision(after, "moderator-checked", "channel.overview")).toBe(
      resourceRevision(before, "moderator-checked", "channel.overview") + 1,
    );
    expect(resourceRevision(after, "moderator-checked", "channels")).toBe(
      resourceRevision(before, "moderator-checked", "channels") + 1,
    );
    expect(after.resources.filter(({ channel_id }) => channel_id === "moderator-other")).toEqual(
      before.resources.filter(({ channel_id }) => channel_id === "moderator-other"),
    );
    expect(after.pending.filter(({ channel_id }) => channel_id === "moderator-other")).toEqual(
      before.pending.filter(({ channel_id }) => channel_id === "moderator-other"),
    );
    expect(globalRevision(after, "channels")).toBe(globalRevision(before, "channels"));

    await setBotChannelStatus(db, "moderator-checked", false, "2026-09-20T00:00:00.000Z", null);
    const afterStateChange = readPanelRevisionState(database);
    expect(globalRevision(afterStateChange, "channels")).toBe(globalRevision(after, "channels") + 1);
  });

  it("revises only the checked channel for an unchanged Helix stream refresh", async () => {
    await insertChannel(database, "stream-checked");
    await insertChannel(database, "stream-other");
    const db = database as unknown as D1Database;
    await writeHelixStreamStateIfUnknown(db, "stream-checked", "online", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "stream-one");
    const before = readPanelRevisionState(database);

    await refreshHelixStreamState(db, "stream-checked", "online", "2026-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "stream-one");

    const after = readPanelRevisionState(database);
    expect(resourceRevision(after, "stream-checked", "channel.overview")).toBe(
      resourceRevision(before, "stream-checked", "channel.overview") + 1,
    );
    expect(resourceRevision(after, "stream-checked", "channels")).toBe(
      resourceRevision(before, "stream-checked", "channels") + 1,
    );
    expect(after.resources.filter(({ channel_id }) => channel_id === "stream-other")).toEqual(
      before.resources.filter(({ channel_id }) => channel_id === "stream-other"),
    );
    expect(after.pending.filter(({ channel_id }) => channel_id === "stream-other")).toEqual(
      before.pending.filter(({ channel_id }) => channel_id === "stream-other"),
    );
    expect(globalRevision(after, "channels")).toBe(globalRevision(before, "channels"));

    const beforeIdenticalRefreshChanges = totalChanges(database);
    await expect(refreshHelixStreamState(
      db,
      "stream-checked",
      "online",
      "2026-09-19T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "stream-one",
    )).resolves.toBe(false);
    expect(totalChanges(database) - beforeIdenticalRefreshChanges).toBe(0);

    await refreshHelixStreamState(db, "stream-checked", "online", "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z", "stream-two");
    expect(globalRevision(readPanelRevisionState(database), "channels")).toBe(globalRevision(after, "channels") + 1);
  });

  it("advances event retention revisions once per affected channel resource", async () => {
    await insertChannel(database, "retention-old");
    await insertChannel(database, "retention-recent");
    const insertEvent = (eventId: string, channelId: string, moduleId: string, createdAt: string) =>
      database.prepare(
        `INSERT INTO event_log (event_id, channel_id, created_at, module_id, trigger_id, code, detail_json)
         VALUES (?, ?, ?, ?, '', 'test', '{}')`,
      ).bind(eventId, channelId, createdAt, moduleId).run();
    await insertEvent("old-text-one", "retention-old", "text_commands", "2026-09-01T00:00:00.000Z");
    await insertEvent("old-text-two", "retention-old", "text_commands", "2026-09-02T00:00:00.000Z");
    await insertEvent("old-ads", "retention-old", "ads", "2026-09-03T00:00:00.000Z");
    await insertEvent("old-faq", "retention-old", "faq", "2026-09-04T00:00:00.000Z");
    await insertEvent("recent-row", "retention-recent", "ads", "2026-10-20T00:00:00.000Z");
    const before = readPanelRevisionState(database);
    const beforeChanges = totalChanges(database);

    await purgeOldEventLogEntries(database as unknown as D1Database, "2026-10-28T00:00:00.000Z");

    const after = readPanelRevisionState(database);
    expect(resourceRevision(after, "retention-old", "channel.events")).toBe(
      resourceRevision(before, "retention-old", "channel.events") + 1,
    );
    for (const resource of ["module:text_commands:data", "module:ads:data", "module:faq:data", "module:ads:schedule"]) {
      expect(resourceRevision(after, "retention-old", resource)).toBe(resourceRevision(before, "retention-old", resource) + 1);
    }
    expect(after.resources.filter(({ channel_id }) => channel_id === "retention-recent")).toEqual(
      before.resources.filter(({ channel_id }) => channel_id === "retention-recent"),
    );
    expect(after.pending.filter(({ channel_id }) => channel_id === "retention-recent")).toEqual(
      before.pending.filter(({ channel_id }) => channel_id === "retention-recent"),
    );
    expect(after.globals).toEqual(before.globals);
    expect(totalChanges(database) - beforeChanges).toBe(24);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log WHERE channel_id = 'retention-old'").first())
      .resolves.toEqual({ count: 0 });
  });

  it("keeps command usage off derived resources and variant choices off all panel resources", async () => {
    await insertChannel(database, "counter-channel");
    await insertChannel(database, "counter-other");
    await database.prepare(
      `INSERT INTO text_commands (channel_id, command_name, response_text, created_at, updated_at)
       VALUES ('counter-channel', 'hello', 'hello {var.name}', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at)
       VALUES ('counter-channel', 'main', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at)
       VALUES ('counter-channel', 'greeting', 'main', 1, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
       VALUES ('counter-channel', 'greeting', 'one', 0, '{}', '["hello"]')`,
    ).run();
    const before = readPanelRevisionState(database);

    await database.prepare(
      "UPDATE text_commands SET use_count = use_count + 1, last_used_at = '2026-09-19T00:00:00.000Z', updated_at = '2026-09-19T00:00:00.000Z' WHERE channel_id = 'counter-channel' AND command_name = 'hello'",
    ).run();
    const afterUsage = readPanelRevisionState(database);
    expect(resourceRevision(afterUsage, "counter-channel", "module:text_commands:commands")).toBe(
      resourceRevision(before, "counter-channel", "module:text_commands:commands") + 1,
    );
    expect(resourceRevision(afterUsage, "counter-channel", "channel.variables")).toBe(
      resourceRevision(before, "counter-channel", "channel.variables"),
    );
    expect(resourceRevision(afterUsage, "counter-channel", "channel.library")).toBe(
      resourceRevision(before, "counter-channel", "channel.library"),
    );
    expect(afterUsage.resources.filter(({ channel_id }) => channel_id === "counter-other")).toEqual(
      before.resources.filter(({ channel_id }) => channel_id === "counter-other"),
    );
    expect(afterUsage.pending.filter(({ channel_id }) => channel_id === "counter-other")).toEqual(
      before.pending.filter(({ channel_id }) => channel_id === "counter-other"),
    );
    expect(afterUsage.globals).toEqual(before.globals);

    await database.prepare(
      "UPDATE text_block_variants SET last_chosen_index = 0 WHERE channel_id = 'counter-channel' AND block_name = 'greeting' AND variant_id = 'one'",
    ).run();
    const afterChoice = readPanelRevisionState(database);
    expect(afterChoice).toEqual(afterUsage);

    await database.prepare(
      "UPDATE text_commands SET response_text = 'updated {var.name}' WHERE channel_id = 'counter-channel' AND command_name = 'hello'",
    ).run();
    const afterCommandChange = readPanelRevisionState(database);
    for (const resource of ["module:text_commands:commands", "channel.variables", "channel.library"]) {
      expect(resourceRevision(afterCommandChange, "counter-channel", resource)).toBe(
        resourceRevision(afterChoice, "counter-channel", resource) + 1,
      );
    }

    await database.prepare(
      `UPDATE text_block_variants SET texts_json = '["updated"]'
        WHERE channel_id = 'counter-channel' AND block_name = 'greeting' AND variant_id = 'one'`,
    ).run();
    const afterVariantChange = readPanelRevisionState(database);
    for (const resource of ["module:text_library:library", "channel.library"]) {
      expect(resourceRevision(afterVariantChange, "counter-channel", resource)).toBe(
        resourceRevision(afterCommandChange, "counter-channel", resource) + 1,
      );
    }
  });

  it("revises the Belabox live resource for each sample write", async () => {
    await insertChannel(database, "belabox-sample");
    await insertChannel(database, "belabox-other");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision)
       VALUES ('belabox-sample', 'belabox', 1, '{"mode":"interval"}', 1)`,
    ).run();
    await database.prepare(
      `INSERT INTO module_secrets (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by)
       VALUES ('belabox-sample', 'belabox', 'stats_url', 'secret-version', 'key-1', 1, '2026-09-18T00:00:00.000Z', 'test')`,
    ).run();
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES ('belabox-sample', 'stream-old', '2026-09-17T00:00:00.000Z', 1, 900)`,
    ).run();
    const before = readPanelRevisionState(database);
    const sample = {
      at: "2026-09-18T00:01:00.000Z",
      connected: true,
      bitrateKbps: 1_000,
      rttMs: 20,
      latencyMs: 30,
      network: 1,
      droppedPackets: 0,
    };

    await expect(writeBelaboxFetch(database as unknown as D1Database, {
      channelId: "belabox-sample",
      sample,
      errorCode: null,
      polling: true,
      streamId: "stream-one",
      streamSessionKey: "session-one",
      belaboxStreamId: "stream-one",
      fetchPhase: { consecutiveFailures: 0, failing: false },
      alertState: createInitialAlertState(),
      recent: [{ at: sample.at, bitrateKbps: sample.bitrateKbps, rttMs: sample.rttMs, connected: sample.connected }],
      beforeSampleWrites: [database.prepare(
        `UPDATE belabox_streams SET ended_at = '2026-09-18T00:00:00.000Z'
          WHERE channel_id = 'belabox-sample' AND stream_id = 'stream-old' AND ended_at IS NULL`,
      ) as unknown as D1PreparedStatement],
      expectedSecretVersion: "secret-version",
      expectedStatusRevision: null,
      expectedModuleRevision: 1,
      history: {
        streamId: "stream-one",
        startedAt: "2026-09-18T00:00:00.000Z",
        minuteAt: "2026-09-18T00:01:00.000Z",
        droppedDelta: 0,
        lowSeconds: 0,
        disconnectedSeconds: 0,
        disconnectCount: 0,
      },
    })).resolves.not.toBeNull();

    await expect(database.prepare(
      "SELECT (SELECT COUNT(*) FROM belabox_minutes WHERE channel_id = 'belabox-sample') AS minutes, (SELECT COUNT(*) FROM belabox_streams WHERE channel_id = 'belabox-sample') AS streams",
    ).first()).resolves.toEqual({ minutes: 1, streams: 2 });
    const after = readPanelRevisionState(database);
    expect(resourceRevision(after, "belabox-sample", "module:belabox:live")).toBe(
      resourceRevision(before, "belabox-sample", "module:belabox:live") + 4,
    );
    expect(after.resources.filter(({ channel_id }) => channel_id === "belabox-other")).toEqual(
      before.resources.filter(({ channel_id }) => channel_id === "belabox-other"),
    );
    expect(after.pending.filter(({ channel_id }) => channel_id === "belabox-other")).toEqual(
      before.pending.filter(({ channel_id }) => channel_id === "belabox-other"),
    );
    expect(after.globals).toEqual(before.globals);

    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES ('belabox-sample', 'stream-finalizer', '2026-09-16T00:00:00.000Z', 1, 800)`,
    ).run();
    const status = await database.prepare(
      "SELECT revision, stream_id, stream_session_key FROM belabox_status WHERE channel_id = 'belabox-sample'",
    ).first<{ revision: number; stream_id: string | null; stream_session_key: string | null }>();
    expect(status).not.toBeNull();
    const finalizers = await prepareBelaboxHistoryFinalizers(
      database as unknown as D1Database,
      "belabox-sample",
      "2026-09-19T00:00:00.000Z",
      1,
      null,
      {
        excludeStreamId: "stream-one",
        expectedStatusRevision: status?.revision ?? null,
        expectedStatusStreamId: status?.stream_id ?? null,
        expectedStatusSessionKey: status?.stream_session_key ?? null,
        expectedSecretVersion: "secret-version",
        expectedModuleMode: "interval",
        finalizeNoncurrentStreams: true,
      },
    );
    expect(finalizers).toHaveLength(1);
    const beforeRejectedStatus = readPanelRevisionState(database);

    await expect(writeBelaboxFetch(database as unknown as D1Database, {
      channelId: "belabox-sample",
      sample: { ...sample, at: "2026-09-19T00:01:00.000Z" },
      errorCode: null,
      polling: true,
      streamId: "stream-one",
      streamSessionKey: "session-one",
      belaboxStreamId: "stream-one",
      fetchPhase: { consecutiveFailures: 0, failing: false },
      alertState: createInitialAlertState(),
      recent: [{ at: "2026-09-19T00:01:00.000Z", bitrateKbps: sample.bitrateKbps, rttMs: sample.rttMs, connected: sample.connected }],
      beforeSampleWrites: finalizers,
      expectedSecretVersion: "secret-version",
      expectedStatusRevision: status?.revision ?? null,
      expectedModuleRevision: 1,
      expectedStreamSession: {
        state: "online",
        changedAt: "2026-09-19T00:00:00.000Z",
        startedAt: "2026-09-19T00:00:00.000Z",
        streamId: "stream-session-mismatch",
      },
      finalizeNoncurrentStreams: true,
    })).resolves.toBeNull();

    const afterRejectedStatus = readPanelRevisionState(database);
    expect(resourceRevision(afterRejectedStatus, "belabox-sample", "module:belabox:live")).toBe(
      resourceRevision(beforeRejectedStatus, "belabox-sample", "module:belabox:live") + 1,
    );
    expect(afterRejectedStatus.resources.filter(({ channel_id }) => channel_id === "belabox-other")).toEqual(
      beforeRejectedStatus.resources.filter(({ channel_id }) => channel_id === "belabox-other"),
    );
    expect(afterRejectedStatus.pending.filter(({ channel_id }) => channel_id === "belabox-other")).toEqual(
      beforeRejectedStatus.pending.filter(({ channel_id }) => channel_id === "belabox-other"),
    );
    expect(afterRejectedStatus.globals).toEqual(beforeRejectedStatus.globals);
    await expect(database.prepare(
      "SELECT ended_at FROM belabox_streams WHERE channel_id = 'belabox-sample' AND stream_id = 'stream-finalizer'",
    ).first<{ ended_at: string | null }>()).resolves.toEqual({ ended_at: "2026-09-19T00:00:00.000Z" });
  });
});
