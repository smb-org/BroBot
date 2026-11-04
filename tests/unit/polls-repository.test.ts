import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PollsEntryInput } from "../../src/modules/polls/contracts";
import { createPollsRepository } from "../../src/modules/polls/repository";
import type { RunSnapshot } from "../../src/modules/polls/domain/runs";
import { TestD1Database } from "./test-d1";

const channelId = "channel_polls";
const now = "2026-11-04T12:00:00.000Z";
const entryInput: PollsEntryInput = {
  kind: "prediction",
  title: "Fictional prediction",
  choices: ["First outcome", "Second outcome"],
  durationSeconds: 30,
  channelPointsVotingEnabled: false,
  channelPointsPerVote: null,
};

const runSnapshot = (twitchId: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  kind: "prediction",
  twitchId,
  title: "Fictional prediction",
  choices: [{ id: "outcome_first", title: "First outcome", votes: null, users: 0, channelPoints: 0 }],
  status: "active",
  startedAt: now,
  endsAt: null,
  lockedAt: null,
  endedAt: null,
  winningChoiceId: null,
  observedAt: now,
  terminalPayload: null,
  ...overrides,
});

describe("polls repository", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
    database.sqlite.prepare(
      `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(channelId, "polls_demo", "Polls demo", now, now);
  });

  afterEach(() => {
    database.close();
  });

  it("creates, updates, lists, and deletes an entry with revision conflict protection", async () => {
    const repository = createPollsRepository(database as unknown as D1Database);
    const created = await repository.createEntry(channelId, entryInput, now);
    expect(created).not.toBe("limit_reached");
    if (created === "limit_reached") throw new Error("Unexpected entry limit.");
    expect(await repository.listEntries(channelId)).toEqual([created]);

    const changed = await repository.updateEntry(channelId, created.id, {
      ...entryInput,
      title: "Updated prediction",
    }, created.revision, "2026-11-04T12:01:00.000Z");
    expect(changed).toMatchObject({ title: "Updated prediction", revision: 2 });
    await expect(repository.updateEntry(channelId, created.id, entryInput, created.revision, now))
      .resolves.toBe("conflict");
    await expect(repository.deleteEntry(channelId, created.id)).resolves.toBe(true);
    await expect(repository.listEntries(channelId)).resolves.toEqual([]);
  });

  it("limits a channel to 200 prepared entries", async () => {
    const repository = createPollsRepository(database as unknown as D1Database);
    for (let index = 0; index < 200; index += 1) {
      const result = await repository.createEntry(channelId, { ...entryInput, title: `Prediction ${String(index)}` }, now);
      expect(result).not.toBe("limit_reached");
    }
    await expect(repository.createEntry(channelId, entryInput, now)).resolves.toBe("limit_reached");
  });

  it("ignores prediction progress after a terminal end snapshot", async () => {
    const repository = createPollsRepository(database as unknown as D1Database);
    await repository.upsertRunSnapshot(channelId, runSnapshot("twitch_prediction_demo", {
      status: "resolved",
      winningChoiceId: "outcome_first",
      endedAt: "2026-11-04T12:02:00.000Z",
      observedAt: "2026-11-04T12:02:00.000Z",
      terminalPayload: { status: "resolved" },
    }));

    await expect(repository.upsertRunSnapshot(channelId, runSnapshot("twitch_prediction_demo", {
      observedAt: "2026-11-04T12:03:00.000Z",
    }))).resolves.toBe("ignored");
    await expect(repository.findRunByTwitchId(channelId, "prediction", "twitch_prediction_demo"))
      .resolves.toMatchObject({ status: "resolved", winningChoiceId: "outcome_first" });
  });

  it("preserves source and entry association when later snapshots omit them", async () => {
    const repository = createPollsRepository(database as unknown as D1Database);
    const entry = await repository.createEntry(channelId, entryInput, now);
    if (entry === "limit_reached") throw new Error("Unexpected entry limit.");
    await repository.upsertRunSnapshot(channelId, runSnapshot("twitch_prediction_demo", {
      source: "brobot",
      entryId: entry.id,
    }));
    await repository.upsertRunSnapshot(channelId, runSnapshot("twitch_prediction_demo", {
      observedAt: "2026-11-04T12:00:02.000Z",
    }));

    await expect(repository.findRunByTwitchId(channelId, "prediction", "twitch_prediction_demo"))
      .resolves.toMatchObject({ source: "brobot", entryId: entry.id });
  });

  it("keeps the prediction refund deadline 24 hours after its creation time", async () => {
    const repository = createPollsRepository(database as unknown as D1Database);
    const createdAt = "2026-11-04T12:00:00.000Z";
    await repository.upsertRunSnapshot(channelId, runSnapshot("twitch_prediction_fictional", {
      startedAt: createdAt,
      endsAt: "2026-11-04T12:02:00.000Z",
      observedAt: "2026-11-04T12:00:03.000Z",
    }));

    await expect(repository.findRunByTwitchId(channelId, "prediction", "twitch_prediction_fictional"))
      .resolves.toMatchObject({
        startedAt: createdAt,
        endsAt: "2026-11-04T12:02:00.000Z",
        refundDeadline: "2026-11-05T12:00:00.000Z",
      });
  });

  it("returns stable history pages ordered by start time", async () => {
    const repository = createPollsRepository(database as unknown as D1Database);
    for (const [twitchId, startedAt] of [
      ["twitch_run_one", "2026-11-04T12:00:00.000Z"],
      ["twitch_run_two", "2026-11-04T12:01:00.000Z"],
      ["twitch_run_three", "2026-11-04T12:02:00.000Z"],
    ] as const) {
      await repository.upsertRunSnapshot(channelId, runSnapshot(twitchId, { startedAt }));
    }

    const first = await repository.listRunHistory(channelId, null, 2);
    const second = await repository.listRunHistory(channelId, first.nextCursor, 2);
    expect(first.runs.map(({ twitchId }) => twitchId)).toEqual(["twitch_run_three", "twitch_run_two"]);
    expect(second.runs.map(({ twitchId }) => twitchId)).toEqual(["twitch_run_one"]);
    expect(second.nextCursor).toBeNull();
  });
});
