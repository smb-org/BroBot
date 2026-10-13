import { describe, expect, it } from "vitest";

import {
  makeTimerPlan,
  sameTimerOccurrence,
  type DurableTimerConfig,
  type DurableTimerStream,
  type TimerOccurrence,
} from "../../src/modules/timers/durable";

const now = Date.parse("2026-10-12T12:00:00.000Z");
const inputs = { now, timeZone: "Europe/Berlin", eventTimes: [] };
const online: DurableTimerStream = {
  state: "online", streamId: "stream-1", startedAt: new Date(now - 60_000).toISOString(), generation: 3,
};
const offline: DurableTimerStream = {
  state: "offline", streamId: null, startedAt: null, generation: 4,
};

const config = (trigger: DurableTimerConfig["trigger"], overrides: Partial<DurableTimerConfig> = {}): DurableTimerConfig => ({
  id: "timer-1",
  name: "Reminder",
  enabled: true,
  messageText: "Hello",
  chatTarget: "source_only",
  trigger,
  revision: 7,
  ...overrides,
});

const occurrence = (identity: NonNullable<ReturnType<typeof makeTimerPlan>["identity"]>, sequence = 1): TimerOccurrence => ({
  identity,
  sequence,
});

const identityOf = (plan: ReturnType<typeof makeTimerPlan>): NonNullable<ReturnType<typeof makeTimerPlan>["identity"]> => {
  if (plan.identity === null) throw new Error("Expected a planned timer occurrence.");
  return plan.identity;
};

describe("Durable Object timer alarm planning", () => {
  it("plans one interval occurrence for the current stream state and keeps cadence after a late fire", () => {
    const timer = config({ type: "interval", live: { minutes: 10 }, offline: { minutes: 20 } });
    const firstPlan = makeTimerPlan(timer, online, null, inputs);
    expect(firstPlan.identity).toMatchObject({
      timerId: "timer-1", revision: 7, triggerType: "interval", state: "live",
      streamId: "stream-1", generation: 3, deadline: now + 10 * 60_000,
    });

    const first = occurrence(identityOf(firstPlan));
    const lateNow = now + 41 * 60_000;
    const next = makeTimerPlan(timer, online, first, { ...inputs, now: lateNow }, "after_occurrence");
    expect(next.identity?.deadline).toBe(now + 50 * 60_000);
    expect(makeTimerPlan(timer, offline, first, inputs).identity).toMatchObject({
      state: "offline", streamId: null, generation: 4, deadline: now + 20 * 60_000,
    });
  });

  it("ties stream-start plans to one stream and consumes them after the occurrence", () => {
    const timer = config({ type: "stream_start", minutes: 5 });
    const firstPlan = makeTimerPlan(timer, online, null, inputs);
    expect(firstPlan.identity).toMatchObject({
      triggerType: "stream_start", streamId: "stream-1", generation: 3, deadline: now + 4 * 60_000,
    });
    expect(makeTimerPlan(timer, online, occurrence(identityOf(firstPlan)), inputs, "after_occurrence").identity).toBeNull();
    expect(makeTimerPlan(timer, { ...online, streamId: "stream-2", generation: 5 }, occurrence(identityOf(firstPlan)), inputs)
      .identity?.streamId).toBe("stream-2");
  });

  it("plans daily and before-event occurrences with the trigger's calendar inputs", () => {
    const daily = makeTimerPlan(config({
      type: "time_of_day", time: "14:00", weekdays: [], alsoOffline: false,
    }), online, null, inputs);
    expect(daily.identity?.triggerType).toBe("time_of_day");
    expect(daily.identity?.deadline).toBeGreaterThan(now);

    const eventAt = new Date(now + 3 * 60 * 60_000).toISOString();
    const beforeEvent = makeTimerPlan(config({
      type: "before_event", sourceId: "schedule.release", minutes: 30,
    }), online, null, {
      ...inputs,
      eventTimes: [{
        id: "schedule.release",
        label: { de: "Veröffentlichung", en: "Release" },
        at: eventAt,
      }],
    });
    expect(beforeEvent.identity?.deadline).toBe(Date.parse(eventAt) - 30 * 60_000);
    expect(beforeEvent.refreshAt).toBeNull();

    const horizon = makeTimerPlan(config({
      type: "before_event", sourceId: "schedule.release", minutes: 30,
    }), online, null, inputs);
    expect(horizon.identity).toBeNull();
    expect(horizon.refreshAt).toBe(now + 14 * 24 * 60 * 60_000);
  });

  it("keeps claims scoped to a full occurrence identity and config revision", () => {
    const plan = makeTimerPlan(config({ type: "interval", live: { minutes: 10 } }), online, null, inputs);
    const claim = occurrence(identityOf(plan));
    expect(sameTimerOccurrence(claim, { ...claim, identity: { ...claim.identity } })).toBe(true);
    expect(sameTimerOccurrence(claim, { ...claim, sequence: claim.sequence + 1 })).toBe(false);
    expect(sameTimerOccurrence(claim, {
      ...claim,
      identity: { ...claim.identity, revision: claim.identity.revision + 1 },
    })).toBe(false);
  });

  it("does not plan disabled timers", () => {
    expect(makeTimerPlan(config({ type: "interval", live: { minutes: 10 } }, { enabled: false }), online, null, inputs))
      .toEqual({ identity: null, refreshAt: null });
  });
});
