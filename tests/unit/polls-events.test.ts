import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { MODULES } from "../../src/modules/registry";
import { pollsModule } from "../../src/modules/polls";
import { processPollsEvent } from "../../src/modules/polls/service";
import { createPollsRepository } from "../../src/modules/polls/repository";
import { TestD1Database } from "./test-d1";

const channelId = "channel_polls";

const event = (
  subscriptionType: string,
  payload: Record<string, unknown>,
  receivedAt: string,
  eventSubTimestamp = receivedAt,
): ModuleEvent => ({
  channelId,
  subscriptionType,
  triggerId: `event_${subscriptionType.replaceAll(".", "_")}`,
  payload,
  settings: {},
  receivedAt,
  eventSubTimestamp,
  actor: null,
  chatStatus: null,
});

describe("polls EventSub handling", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
    database.sqlite.prepare(
      `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(channelId, "polls_demo", "Polls demo", "2026-11-04", "2026-11-04");
  });

  afterEach(() => {
    database.close();
  });

  it("keeps a prediction resolved when an older progress event follows its lock", async () => {
    const context = { DB: database as unknown as D1Database } as ModuleExecutionContext;
    const payload = {
      id: "twitch_prediction_demo",
      broadcaster_user_id: channelId,
      title: "Fictional prediction",
      outcomes: [
        { id: "outcome_first", title: "First", users: 3, channel_points: 90 },
        { id: "outcome_second", title: "Second", users: 1, channel_points: 10 },
      ],
      started_at: "2026-11-04T12:00:00.000Z",
      locks_at: "2026-11-04T12:02:00.000Z",
      locked_at: "2026-11-04T12:02:00.000Z",
      ended_at: "2026-11-04T12:03:00.000Z",
      winning_outcome_id: "outcome_first",
    };
    await processPollsEvent(event("channel.prediction.begin", payload, "2026-11-04T12:00:00.100Z"), context);
    await processPollsEvent(event("channel.prediction.lock", payload, "2026-11-04T12:02:00.100Z"), context);
    await processPollsEvent(
      event("channel.prediction.progress", payload, "2026-11-04T12:02:30.100Z", "2026-11-04T12:01:00.000Z"),
      context,
    );
    await processPollsEvent(event("channel.prediction.end", { ...payload, status: "resolved" }, "2026-11-04T12:03:00.100Z"), context);

    await expect(createPollsRepository(database as unknown as D1Database)
      .findRunByTwitchId(channelId, "prediction", "twitch_prediction_demo"))
      .resolves.toMatchObject({ status: "resolved", winningChoiceId: "outcome_first" });
  });

  it("records a Twitch poll start without a prepared entry", async () => {
    const context = { DB: database as unknown as D1Database } as ModuleExecutionContext;
    await processPollsEvent(event("channel.poll.begin", {
      id: "twitch_poll_demo",
      broadcaster_user_id: channelId,
      title: "Fictional poll",
      choices: [{ id: "choice_first", title: "First" }, { id: "choice_second", title: "Second" }],
      started_at: "2026-11-04T12:00:00.000Z",
      ends_at: "2026-11-04T12:01:00.000Z",
    }, "2026-11-04T12:00:00.100Z"), context);

    await expect(createPollsRepository(database as unknown as D1Database)
      .findRunByTwitchId(channelId, "poll", "twitch_poll_demo"))
      .resolves.toMatchObject({ source: "twitch", entryId: null, status: "active" });
  });

  it("registers poll and prediction subscriptions with broadcaster scopes", () => {
    expect(MODULES).toContain(pollsModule);
    expect(pollsModule.eventSubTypes).toEqual([
      "channel.poll.begin", "channel.poll.progress", "channel.poll.end",
      "channel.prediction.begin", "channel.prediction.progress", "channel.prediction.lock", "channel.prediction.end",
    ]);
    expect(pollsModule.pauseSafeEventSubTypes).toEqual(pollsModule.eventSubTypes);
    expect(pollsModule.broadcasterScopes).toEqual(["channel:manage:polls", "channel:manage:predictions"]);
  });
});
