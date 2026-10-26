import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BOT_SCOPES, missingBotScopes } from "../../src/worker/auth/oauth";
import { maintainBotIdentity } from "../../src/worker/bot-maintenance";
import {
  setBotIdentityMissingScopesIfCurrent,
  setBotIdentityStatus,
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { upsertEventSubSubscription } from "../../src/worker/db/eventsub-state";
import { insertChannel } from "./fixtures";
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

  it("revises panel resources when heartbeat timestamps change", async () => {
    await insertChannel(database, "bookkeeping-only");
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
      resourceRevision(before, "bookkeeping-only", "channel.overview") + 1,
    );
    expect(globalRevision(afterStatus, "channels")).toBe(globalRevision(before, "channels") + 1);

    await database.prepare("UPDATE eventsub_subscriptions SET updated_at = '2026-09-19T00:00:00.000Z' WHERE channel_id = 'bookkeeping-only'").run();
    const afterSubscription = readPanelRevisionState(database);
    expect(resourceRevision(afterSubscription, "bookkeeping-only", "channel.overview")).toBe(
      resourceRevision(afterStatus, "bookkeeping-only", "channel.overview") + 1,
    );
    expect(globalRevision(afterSubscription, "channels")).toBe(globalRevision(afterStatus, "channels") + 1);
  });
});
