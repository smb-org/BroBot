import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { purgeRevokedOverlayAccesses } from "../../src/worker/auth/overlay-access-repository";
import { scheduled } from "../../src/worker/scheduled";
import { insertChannel, jsonResponse, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-10-01T03:00:00.000Z";

describe("overlay access maintenance", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    database.close();
  });

  const insertAccess = async (
    tokenId: string,
    revokedAt: string | null,
    overlayId: string | null = "overlay-a",
    channelId = "channel-a",
  ): Promise<void> => {
    await database.prepare(
      `INSERT INTO overlay_tokens
        (token_id, channel_id, token_hash, created_at, revoked_at, overlay_id, label)
       VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', ?, ?, ?)`,
    ).bind(tokenId, channelId, `hash-${tokenId}`, revokedAt, overlayId, tokenId).run();
  };

  it("purges at the 30-day boundary and atomically records channel-scoped removal snapshots", async () => {
    await insertAccess("revoked-29-days", "2026-09-02T03:00:00.000Z");
    await insertAccess("revoked-30-days", "2026-09-01T03:00:00.000Z");
    await insertAccess("active", null);
    await insertAccess("legacy-revoked", "2026-08-01T00:00:00.000Z", null);
    await insertChannel(database, "channel-b");
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-b', 'channel-b', 'Other channel', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run();
    await insertAccess("other-channel-revoked", "2026-09-01T03:00:00.000Z", "overlay-b", "channel-b");
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES ('audit-revoke', 'user-1', ?, 'channel-a', 'overlay.access.revoked', '{}', '{}')`,
    ).bind("2026-09-01T03:00:00.000Z").run();

    await purgeRevokedOverlayAccesses(database as unknown as D1Database, NOW);

    const rows = await database.prepare("SELECT token_id FROM overlay_tokens ORDER BY token_id").all<{ token_id: string }>();
    expect(rows.results.map((row) => row.token_id)).toEqual(["active", "legacy-revoked", "revoked-29-days"]);
    const audits = await database.prepare("SELECT action FROM audit_log WHERE audit_id = 'audit-revoke'").all<{ action: string }>();
    expect(audits.results).toEqual([{ action: "overlay.access.revoked" }]);

    const removals = await database.prepare(
      `SELECT channel_id, actor_user_id, actor_kind, before_json, after_json
         FROM audit_log WHERE action = 'overlay.access.removed' ORDER BY channel_id`,
    ).all<{ channel_id: string; actor_user_id: string | null; actor_kind: string; before_json: string; after_json: string }>();
    expect(removals.results.map(({ channel_id, actor_user_id, actor_kind, after_json }) => ({ channel_id, actor_user_id, actor_kind, after_json })))
      .toEqual([
        { channel_id: "channel-a", actor_user_id: null, actor_kind: "system", after_json: "null" },
        { channel_id: "channel-b", actor_user_id: null, actor_kind: "system", after_json: "null" },
      ]);
    expect(JSON.parse(removals.results[0]?.before_json ?? "null")).toMatchObject({
      tokenId: "revoked-30-days", overlayId: "overlay-a", label: "revoked-30-days",
      revokedAt: "2026-09-01T03:00:00.000Z",
    });
    expect(JSON.parse(removals.results[1]?.before_json ?? "null")).toMatchObject({
      tokenId: "other-channel-revoked", overlayId: "overlay-b", label: "other-channel-revoked",
      revokedAt: "2026-09-01T03:00:00.000Z",
    });
  });

  it("rolls back cleanup audit snapshots if a deletion fails", async () => {
    await insertAccess("delete-fails", "2026-09-01T03:00:00.000Z");
    await database.prepare(
      `CREATE TRIGGER reject_overlay_access_cleanup
       BEFORE DELETE ON overlay_tokens WHEN OLD.token_id = 'delete-fails'
       BEGIN SELECT RAISE(ABORT, 'cleanup delete rejected'); END`,
    ).run();

    await expect(purgeRevokedOverlayAccesses(database as unknown as D1Database, NOW)).rejects.toThrow("cleanup delete rejected");
    expect(await database.prepare("SELECT token_id FROM overlay_tokens WHERE token_id = 'delete-fails'").first())
      .toEqual({ token_id: "delete-fails" });
    expect(await database.prepare("SELECT action FROM audit_log WHERE action = 'overlay.access.removed'").all())
      .toMatchObject({ results: [] });
  });

  it("runs the 30-day purge in the nightly scheduled hour", async () => {
    vi.useFakeTimers();
    await insertAccess("revoked-30-days", "2026-09-01T03:00:00.000Z");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve(url === "https://id.twitch.tv/oauth2/token"
        ? jsonResponse({ access_token: "scheduled-token", expires_in: 7200 })
        : jsonResponse({ data: [] }));
    }));
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      TWITCH_CLIENT_SECRET: "client-secret",
      SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(3) }, retired: [] }),
      TOKEN_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(3) }, retired: [] }),
    } as Env;
    const run = async (): Promise<void> => {
      await scheduled(
        {} as ScheduledController,
        environment,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );
    };

    vi.setSystemTime(new Date("2026-10-01T02:00:00.000Z"));
    await run();
    expect(await database.prepare("SELECT token_id FROM overlay_tokens WHERE token_id = 'revoked-30-days'").first())
      .toEqual({ token_id: "revoked-30-days" });

    vi.setSystemTime(new Date(NOW));
    await run();
    expect(await database.prepare("SELECT token_id FROM overlay_tokens WHERE token_id = 'revoked-30-days'").first())
      .toBeNull();
  });
});
