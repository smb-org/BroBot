import { afterEach, describe, expect, it } from "vitest";

import type { ModuleRegisteredTemplateVariable } from "../../src/modules/contract";
import { nextDailyTimerAt, nextBeforeEventAt, nextIntervalAt, nextStreamStartAt, timerOccurrenceKey } from "../../src/modules/timers/domain";
import { validateTimerBlock } from "../../src/modules/timers/service";
import { TestD1Database } from "./test-d1";

const berlin = "Europe/Berlin";

describe("timer scheduling", () => {
  it("keeps interval deadlines on cadence after a late alarm", () => {
    expect(nextIntervalAt(1_000, 1_000 + 31 * 60_000, 15)).toBe(1_000 + 45 * 60_000);
  });

  it("schedules a stream-start timer created during a live stream only while its due time remains ahead", () => {
    const startedAt = "2026-09-27T12:00:00.000Z";
    expect(nextStreamStartAt(startedAt, Date.parse("2026-09-27T12:05:00.000Z"), 10 * 60_000))
      .toBe(Date.parse("2026-09-27T12:10:00.000Z"));
    expect(nextStreamStartAt(startedAt, Date.parse("2026-09-27T12:11:00.000Z"), 10 * 60_000)).toBeNull();
  });

  it("moves a nonexistent daily wall time to the first valid time after the DST gap", () => {
    const next = nextDailyTimerAt({ type: "time_of_day", time: "02:30", weekdays: [], alsoOffline: false },
      Date.parse("2026-03-28T12:00:00.000Z"), berlin);

    expect(next).toBe(Date.parse("2026-03-29T01:30:00.000Z"));
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: berlin, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date(next ?? 0))).toBe("03:30");
  });

  it("runs selected weekdays in channel-local time", () => {
    const next = nextDailyTimerAt({ type: "time_of_day", time: "02:30", weekdays: [1], alsoOffline: false },
      Date.parse("2026-03-29T01:45:00.000Z"), berlin);

    expect(next).toBe(Date.parse("2026-03-30T00:30:00.000Z"));
  });

  it("creates a distinct stable due-time key for each sunset in a multi-day stream", () => {
    const trigger = { type: "before_event" as const, sourceId: "sun.sunset", minutes: 10 };
    const events = [
      { id: "sun.sunset", label: { de: "Sonnenuntergang", en: "Sunset" }, at: "2026-06-21T19:33:00.000Z" },
      { id: "sun.sunset", label: { de: "Sonnenuntergang", en: "Sunset" }, at: "2026-06-22T19:34:00.000Z" },
    ];
    const firstDue = nextBeforeEventAt(trigger, events, Date.parse("2026-06-21T18:00:00.000Z"));
    const secondDue = nextBeforeEventAt(trigger, events, (firstDue ?? 0) + 1);

    expect(firstDue).toBe(Date.parse("2026-06-21T19:23:00.000Z"));
    expect(secondDue).toBe(Date.parse("2026-06-22T19:24:00.000Z"));
    expect(timerOccurrenceKey("timer-1", firstDue ?? 0)).toBe(timerOccurrenceKey("timer-1", firstDue ?? 0));
    expect(timerOccurrenceKey("timer-1", firstDue ?? 0)).not.toBe(timerOccurrenceKey("timer-1", secondDue ?? 0));
  });
});

describe("scheduled text block validation", () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });

  const databaseWithBlocks = async (blocks: Readonly<Record<string, readonly string[]>>): Promise<TestD1Database> => {
    const database = new TestD1Database();
    databases.push(database);
    await database.prepare("INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind("channel-1", "channelone", "Channel One", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
    await database.prepare("INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind("channel-1", "custom", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
    for (const [name, texts] of Object.entries(blocks)) {
      await database.prepare("INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
        .bind("channel-1", name, "custom", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
      await database.prepare("INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json) VALUES (?, ?, ?, 0, '{}', ?)")
        .bind("channel-1", name, `${name}-variant`, JSON.stringify(texts)).run();
    }
    return database;
  };

  it("accepts event variables and rejects direct command-input variables", async () => {
    const database = await databaseWithBlocks({ welcome: ["Welcome, {date}."] , personalized: ["Hello {target}: {args}"] });

    await expect(validateTimerBlock(database as unknown as D1Database, "channel-1", "welcome", []))
      .resolves.toEqual({ ok: true });
    await expect(validateTimerBlock(database as unknown as D1Database, "channel-1", "personalized", []))
      .resolves.toEqual({ ok: false, reason: "input_dependent" });
  });

  it("checks nested text blocks for command-input variables", async () => {
    const database = await databaseWithBlocks({ welcome: ["{nested}"], nested: ["Hello {target}."] });
    const nestedVariable = {
      name: "nested", sample: "Hello", maxLength: 80, group: "context", moduleId: "text_library", isTextBlock: true,
    } satisfies ModuleRegisteredTemplateVariable;

    await expect(validateTimerBlock(database as unknown as D1Database, "channel-1", "welcome", [nestedVariable]))
      .resolves.toEqual({ ok: false, reason: "input_dependent" });
  });
});
