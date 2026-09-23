import { afterEach, describe, expect, it } from "vitest";

import { auditAreaSqlClause } from "../../src/worker/panel/repository";
import { TestD1Database } from "./test-d1";

describe("audit filter indexes", () => {
  let database: TestD1Database | null = null;

  afterEach(() => database?.close());

  it("uses the channel + actor index for person filters", () => {
    database = new TestD1Database();
    const plan = database.sqlite.prepare(
      `EXPLAIN QUERY PLAN
       SELECT audit_id, actor_user_id, created_at, channel_id, action
         FROM audit_log
        WHERE channel_id = ? AND actor_user_id = ?
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`,
    ).all("channel-1", "user-1", 51) as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join(" ")).toContain("audit_log_channel_actor_created_idx");
  });

  it("uses the channel + action index for every prefix area filter", () => {
    database = new TestD1Database();
    for (const name of ["command", "member", "overlay", "channel"] as const) {
      const area = auditAreaSqlClause(name);
      const plan = database.sqlite.prepare(
        `EXPLAIN QUERY PLAN
         SELECT audit_id, actor_user_id, created_at, channel_id, action
           FROM audit_log
          WHERE channel_id = ? AND ${area.sql}
          ORDER BY created_at DESC, audit_id DESC
          LIMIT ?`,
      ).all("channel-1", ...area.values, 51) as Array<{ detail: string }>;

      expect(plan.map((row) => row.detail).join(" "), name).toContain("audit_log_channel_action_created_idx");
    }
  });

  it("keeps the module catch-all area scoped to unprefixed actions", () => {
    database = new TestD1Database();
    const actions = [
      "module.enabled",
      "member.added",
      "overlay.token.issued",
      "channel.released",
      "text_commands.command.created",
      "channelx.custom",
      "text_commands.other",
    ];
    const area = auditAreaSqlClause("module");
    const placeholders = actions.map(() => "(?)").join(", ");
    const rows = database.sqlite.prepare(
      `WITH audit_actions(action) AS (VALUES ${placeholders})
       SELECT action FROM audit_actions WHERE ${area.sql} ORDER BY action`,
    ).all(...actions, ...area.values) as Array<{ action: string }>;

    expect(rows.map((row) => row.action)).toEqual(["channelx.custom", "module.enabled", "text_commands.other"]);
  });
});
