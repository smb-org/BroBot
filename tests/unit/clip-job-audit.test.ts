import { afterEach, describe, expect, it } from "vitest";

import { writeModuleAudit } from "../../src/worker/module-audit";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("durable clip audit idempotency", () => {
  let database: TestD1Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("records a null-module clip creation audit once across retries", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    const entry = {
      channelId: "channel-a",
      moduleId: null,
      action: "clip.created" as const,
      before: null,
      after: { clipId: "clip-1", availabilityConfirmed: true },
    };
    const options = {
      operationId: "clip-created:channel-a:eventsub-trigger",
      actorUserId: "viewer-1",
    };

    await writeModuleAudit(database as unknown as D1Database, "viewer-1", "2026-10-19T10:00:00.000Z", entry, "member", options);
    await writeModuleAudit(database as unknown as D1Database, "viewer-1", "2026-10-19T10:01:00.000Z", entry, "member", options);

    await expect(database.prepare(
      `SELECT COUNT(*) AS count, json_extract(MAX(after_json), '$.operationId') AS operation_id
         FROM audit_log WHERE channel_id = ? AND action = 'clip.created'`,
    ).bind("channel-a").first()).resolves.toEqual({ count: 1, operation_id: options.operationId });
  });
});
