import { describe, expect, it } from "vitest";

import { writeEventSubStreamState } from "../../src/worker/db/stream-state";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

// Regression tests for the SonarCloud "super-linear regex" finding: the
// fractional-seconds capture in `timestampOrder` is bounded to 9 digits and
// trailing zeros are trimmed with a loop instead of a backtracking regex.
// These go through the public `writeEventSubStreamState` API rather than the
// unexported `timestampOrder`, since fraction equality is only observable via
// the offline-boundary comparison it feeds.
describe("timestampOrder fraction handling", () => {
  it("normalizes trailing zeros so equal fractions of different lengths compare equal", async () => {
    const database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
       VALUES (?, 'online', ?, 'eventsub', ?)`,
    ).bind("kanal-a", "2026-09-23T12:00:00.1Z", "2026-09-23T12:00:00.1Z").run();

    // "…00.100Z" (trims to "1") must equal "…00.1Z" (already "1"): an event
    // exactly at the known session boundary is unorderable, not a hang.
    const result = await writeEventSubStreamState(
      database as unknown as D1Database,
      "kanal-a",
      "offline",
      "2026-09-23T12:00:00.100Z",
      null,
    );

    expect(result).toBe("ambiguous_offline");
  });

  it("treats a run of trailing zeros the same as no fraction at all", async () => {
    const database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
       VALUES (?, 'online', ?, 'eventsub', ?)`,
    ).bind("kanal-a", "2026-09-23T12:00:00Z", "2026-09-23T12:00:00Z").run();

    const result = await writeEventSubStreamState(
      database as unknown as D1Database,
      "kanal-a",
      "offline",
      "2026-09-23T12:00:00.000000000Z",
      null,
    );

    expect(result).toBe("ambiguous_offline");
  });

  it("rejects a fraction longer than 9 digits as an invalid timestamp", async () => {
    const database = new TestD1Database();

    const result = await writeEventSubStreamState(
      database as unknown as D1Database,
      "kanal-a",
      "offline",
      "2026-09-23T12:00:00.1234567890Z",
      null,
    );

    expect(result).toBe("invalid_timestamp");
  });
});
