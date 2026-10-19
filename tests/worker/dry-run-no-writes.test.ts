import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_VOTEKICK_SETTINGS } from "../../src/modules/votekick/contracts";
import { createVotekickRepository } from "../../src/modules/votekick/adapters/d1";
import { alarmKeyFor } from "../../src/modules/timers/domain";
import { dryRunChatMessage } from "../../src/worker/dry-run";

const migrationSources = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const migrationStatements = (source: string): string[] => {
  const segments = source
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*--.*$/u, ""))
    .join("\n")
    .split(";");
  const statements: string[] = [];
  let trigger: string[] | null = null;
  for (const segment of segments) {
    const statement = segment.trim();
    if (statement.length === 0) continue;
    if (trigger !== null) {
      if (statement.toUpperCase() === "END") {
        statements.push(`${trigger.join(";")};${statement}`);
        trigger = null;
      } else {
        trigger.push(statement);
      }
    } else if (/^CREATE\s+TRIGGER\b/iu.test(statement)) {
      trigger = [statement];
    } else {
      statements.push(statement);
    }
  }
  return statements;
};

const database = (env as unknown as { DB: D1Database }).DB;

beforeAll(async () => {
  for (const path of Object.keys(migrationSources).sort((left, right) => left.localeCompare(right))) {
    for (const statement of migrationStatements(migrationSources[path] ?? "")) {
      await database.prepare(statement).run();
    }
  }
});

describe("dry-run Durable Object reads", () => {
  it("does not initialize a cold ChannelObject with configured timers", async () => {
    const channelId = `dry-run-cold-channel-${crypto.randomUUID()}`;
    const timerId = `dry-run-cold-timer-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await database.prepare(
      `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(channelId, channelId, channelId, now, now).run();
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)")
      .bind(channelId, JSON.stringify(DEFAULT_VOTEKICK_SETTINGS)).run();
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'timers', 1, '{}')")
      .bind(channelId).run();
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
       VALUES (?, 'offline', ?, 'helix')`,
    ).bind(channelId, now).run();
    await database.prepare(
      `INSERT INTO timers
        (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, revision,
         next_run_at, next_run_state, last_run_at, created_at, updated_at)
       VALUES (?, ?, 'Cold timer', 1, 'Hello!', 'interval', ?, 1, NULL, NULL, NULL, ?, ?)`,
    ).bind(timerId, channelId, JSON.stringify({ type: "interval", offline: { minutes: 30 } }), now, now).run();
    const votekicks = createVotekickRepository(database);
    await votekicks.admit(channelId, {
      id: "cold-object-votekick",
      targetUserId: "target-id",
      targetLogin: "target_viewer",
      initiatorUserId: "starter-id",
      threshold: 3,
      yesVotes: 0,
      ballotRevision: 1,
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      endsAt: new Date(Date.now() + 30_000).toISOString(),
    }, now, 0, 0);
    const before = await database.prepare(
      `SELECT next_run_at, next_run_state FROM timers WHERE channel_id = ? AND timer_id = ?`,
    ).bind(channelId, timerId).first();
    const revisionsBefore = await database.prepare(
      "SELECT resource, revision FROM panel_resource_revisions WHERE channel_id = ? ORDER BY resource",
    ).bind(channelId).all();

    await dryRunChatMessage(env, channelId, {
      text: "1",
      sender: { login: "viewer_42", statuses: [] },
      streamState: "offline",
      game: null,
      sharedChat: false,
      only: { moduleId: "votekick" },
    }, fetch);

    const after = await database.prepare(
      `SELECT next_run_at, next_run_state FROM timers WHERE channel_id = ? AND timer_id = ?`,
    ).bind(channelId, timerId).first();
    const revisionsAfter = await database.prepare(
      "SELECT resource, revision FROM panel_resource_revisions WHERE channel_id = ? ORDER BY resource",
    ).bind(channelId).all();
    const channelObject = env.CHANNEL.get(env.CHANNEL.idFromName(channelId));

    expect(after).toEqual(before);
    expect(revisionsAfter.results).toEqual(revisionsBefore.results);
    expect(await channelObject.getModuleAlarmDeadline("timers", alarmKeyFor(timerId))).toBeNull();
  });
});
