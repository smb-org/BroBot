import { describe, expect, it } from "vitest";

import { readChannelControls, setChannelControl } from "../../src/worker/db/channel-controls";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-23T09:00:00.000Z";
const actor = { userId: "operator-1", sessionId: "session-operator-1" };

const seedOperator = async (database: TestD1Database): Promise<void> => {
  await insertChannel(database, "kanal-a");
  await insertLoginIdentityAndSession(database, actor.userId);
  await insertMember(database, "kanal-a", actor.userId, "operator");
};

describe("channel controls", () => {
  it("expires timed mute and pause from fresh reads and audits member toggles", async () => {
    const database = new TestD1Database();
    try {
      await seedOperator(database);
      const mute = await setChannelControl(database as unknown as D1Database, actor, "kanal-a", "mute", "15m", NOW);
      const pause = await setChannelControl(database as unknown as D1Database, actor, "kanal-a", "pause", "1h", NOW);

      expect(mute.controls.mute).toEqual({ active: true, until: "2026-09-23T09:15:00.000Z", mode: "timed" });
      expect(pause.controls.pause).toEqual({ active: true, until: "2026-09-23T10:00:00.000Z", mode: "timed" });
      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", "2026-09-23T09:14:59.999Z"))
        .resolves.toMatchObject({ mute: { active: true }, pause: { active: true } });
      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", "2026-09-23T09:15:00.000Z"))
        .resolves.toMatchObject({ mute: { active: false }, pause: { active: true } });
      await expect(readChannelControls(database as unknown as D1Database, "kanal-a", "2026-09-23T10:00:00.000Z"))
        .resolves.toEqual({
          mute: { active: false, until: null, mode: null },
          pause: { active: false, until: null, mode: null },
        });

      const audits = await database.prepare("SELECT actor_user_id, action, actor_kind FROM audit_log ORDER BY created_at, action")
        .all<{ actor_user_id: string; action: string; actor_kind: string }>();
      expect(audits.results).toEqual([
        { actor_user_id: actor.userId, action: "channel.mute.enabled", actor_kind: "member" },
        { actor_user_id: actor.userId, action: "channel.pause.enabled", actor_kind: "member" },
      ]);
    } finally {
      database.close();
    }
  });
});
