import { describe, expect, it } from "vitest";

import {
  CLAIM_ELIGIBLE_SQL,
  createTextCommandRepository,
  createTextCommandPeekRepository,
  peekClaim,
} from "../../src/modules/text_commands/adapters/d1";
import { readOnlyD1 } from "../../src/worker/db/read-only";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";
const CHANNEL_ID = "kanal-a";
const USER_ID = "synthetic:viewer_42";

const repositoriesFor = async (lastUsedAt: string | null = null) => {
  const productionDb = new TestD1Database();
  const peekDb = new TestD1Database();
  for (const database of [productionDb, peekDb]) {
    await insertChannel(database, CHANNEL_ID);
    const repository = createTextCommandRepository(
      database as unknown as D1Database,
      () => ({ sql: "AND 1 = 1", values: [] }),
    );
    await repository.create({
      channelId: CHANNEL_ID,
      name: "hello",
      text: "Hallo",
      kind: "text",
      cooldownSeconds: 60,
      userCooldownSeconds: 120,
      now: NOW,
    }, { userId: "member-1" });
    if (lastUsedAt !== null) {
      await database.prepare("UPDATE text_commands SET last_used_at = ? WHERE channel_id = ? AND command_name = ?")
        .bind(lastUsedAt, CHANNEL_ID, "hello").run();
    }
  }
  const production = createTextCommandRepository(
    productionDb as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] }),
  );
  const peek = createTextCommandPeekRepository(readOnlyD1(peekDb as unknown as D1Database));
  return { production, peek, productionDb, peekDb };
};

describe("text-command peek claims", () => {
  it("exports the shared production predicate and direct peek adapter", async () => {
    expect(CLAIM_ELIGIBLE_SQL).toContain("user_cooldown_seconds");
    const { peekDb } = await repositoriesFor();

    await expect(peekClaim(
      readOnlyD1(peekDb as unknown as D1Database),
      CHANNEL_ID,
      "hello",
      NOW,
      USER_ID,
      120,
      undefined,
      undefined,
    )).resolves.toMatchObject({ claimed: true, command: { useCount: 1, lastUsedAt: NOW } });
    peekDb.close();
  });

  it("matches a successful production claim without consuming the peeked command", async () => {
    const { production, peek, productionDb, peekDb } = await repositoriesFor();
    const command = await peek.find(CHANNEL_ID, "hello");
    expect(command).not.toBeNull();
    const [claimed, peeked] = await Promise.all([
      production.claim(CHANNEL_ID, "hello", NOW, USER_ID, 120, undefined, undefined, command ?? undefined),
      peek.claim(CHANNEL_ID, "hello", NOW, USER_ID, 120, undefined, undefined, command ?? undefined),
    ]);

    expect(claimed?.claimed).toBe(true);
    expect(peeked).toMatchObject({ claimed: true, command: { useCount: 1, lastUsedAt: NOW } });
    await expect(peekDb.prepare("SELECT use_count, last_used_at FROM text_commands WHERE command_name = 'hello'")
      .first()).resolves.toEqual({ use_count: 0, last_used_at: null });
    productionDb.close();
    peekDb.close();
  });

  it("uses the production global cooldown decision and remaining seconds", async () => {
    const { production, peek, productionDb, peekDb } = await repositoriesFor(NOW);
    const command = await peek.find(CHANNEL_ID, "hello");
    const later = "2026-09-19T12:00:30.000Z";
    const [claimed, peeked] = await Promise.all([
      production.claim(CHANNEL_ID, "hello", later, USER_ID, 120, undefined, undefined, command ?? undefined),
      peek.claim(CHANNEL_ID, "hello", later, USER_ID, 120, undefined, undefined, command ?? undefined),
    ]);

    expect(claimed).toMatchObject({ claimed: false, reason: "cooldown", remainingSeconds: 30 });
    expect(peeked).toMatchObject({ claimed: false, reason: "cooldown", remainingSeconds: 30 });
    productionDb.close();
    peekDb.close();
  });

  it("uses the production per-user cooldown decision for the synthetic sender id", async () => {
    const previousUse = "2026-09-19T11:58:50.000Z";
    const { production, peek, productionDb, peekDb } = await repositoriesFor(previousUse);
    for (const database of [productionDb, peekDb]) {
      await database.prepare(
        "INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at) VALUES (?, ?, ?, ?)",
      ).bind(CHANNEL_ID, "hello", USER_ID, "2026-09-19T11:59:50.000Z").run();
    }
    const command = await peek.find(CHANNEL_ID, "hello");
    const [claimed, peeked] = await Promise.all([
      production.claim(CHANNEL_ID, "hello", NOW, USER_ID, 120, undefined, undefined, command ?? undefined),
      peek.claim(CHANNEL_ID, "hello", NOW, USER_ID, 120, undefined, undefined, command ?? undefined),
    ]);

    expect(claimed).toMatchObject({ claimed: false, reason: "user_cooldown", remainingSeconds: 110 });
    expect(peeked).toMatchObject({ claimed: false, reason: "user_cooldown", remainingSeconds: 110 });
    productionDb.close();
    peekDb.close();
  });

  it("reports the same stale revision result as the production claim", async () => {
    const { production, peek, productionDb, peekDb } = await repositoriesFor();
    const command = await peek.find(CHANNEL_ID, "hello");
    await Promise.all([productionDb, peekDb].map((database) => database.prepare(
      "UPDATE text_commands SET revision = revision + 1 WHERE channel_id = ? AND command_name = ?",
    ).bind(CHANNEL_ID, "hello").run()));

    const [claimed, peeked] = await Promise.all([
      production.claim(CHANNEL_ID, "hello", NOW, USER_ID, 120, undefined, undefined, command ?? undefined),
      peek.claim(CHANNEL_ID, "hello", NOW, USER_ID, 120, undefined, undefined, command ?? undefined),
    ]);

    expect(claimed).toMatchObject({ claimed: false, stale: true });
    expect(peeked).toMatchObject({ claimed: false, stale: true });
    productionDb.close();
    peekDb.close();
  });
});
