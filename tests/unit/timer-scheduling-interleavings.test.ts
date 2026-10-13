import { describe, expect, it } from "vitest";

import type { ModuleAlarmIdentity } from "../../src/modules/contract";
import {
  acceptsTimerAlarmClear,
  acceptsTimerAlarmSet,
  sameTimerAlarmIdentity,
} from "../../src/modules/timers/identity";

type TimerKind = "interval" | "stream_start" | "time_of_day" | "before_event";
type StreamState = "online" | "offline";
type OperationKind = "event_online" | "event_offline" | "helix_transition" | "alarm_fire" | "save_update" | "pause_resume" | "do_restart";
type Plan = { identity: ModuleAlarmIdentity | null; sequence: number };
type AlarmEntry = { identity: ModuleAlarmIdentity; planSequence: number };
type PendingWrite = { action: "set"; identity: ModuleAlarmIdentity; planSequence: number } |
  { action: "clear"; expectedIdentity: ModuleAlarmIdentity | null; planSequence: number } |
  { action: "none" };

interface TimerModel {
  kind: TimerKind;
  streamState: StreamState;
  streamId: string | null;
  streamGeneration: number;
  enabled: boolean;
  revision: number;
  plan: Plan;
  alarm: AlarmEntry | null;
  planFence: { identity: ModuleAlarmIdentity | null; planSequence: number; cleared: boolean } | null;
  activityCount: number;
  baseline: number;
  baselineState: StreamState;
  baselineGeneration: number;
  now: number;
  posts: Array<{
    identity: ModuleAlarmIdentity;
    baseline: number;
    activity: number;
    baselineState: StreamState;
    baselineGeneration: number;
  }>;
  firstDailyDeadline: number | null;
  firstDailySent: boolean;
  firstDailyEligible: boolean;
}

interface Operation {
  kind: OperationKind;
  capturedAlarm: AlarmEntry | null;
  pending: PendingWrite;
}

const INITIAL_DEADLINE = 10_000;
const INTERVAL_MS = 6_000;
const DAILY_MS = 86_400_000;
const MINIMUM_MESSAGES = 3;

const identityFor = (
  model: TimerModel,
  deadline: number,
  state: "live" | "offline" | null,
  streamId: string | null,
  generation: number | null,
): ModuleAlarmIdentity => ({
  timerId: "timer-harness",
  revision: model.revision,
  triggerType: model.kind,
  state,
  streamId,
  generation,
  deadline,
});

const currentIdentity = (model: TimerModel): ModuleAlarmIdentity | null => model.plan.identity;

const expectedPlanMatches = (model: TimerModel, expected: Plan, expectedRevision: number): boolean =>
  model.revision === expectedRevision && model.plan.sequence === expected.sequence &&
  (expected.identity === null ? model.plan.identity === null :
    sameTimerAlarmIdentity(model.plan.identity, expected.identity));

const writePlan = (
  model: TimerModel,
  identity: ModuleAlarmIdentity | null,
  expected: Plan,
  expectedRevision: number,
  resetBaseline: boolean,
): PendingWrite => {
  if (!expectedPlanMatches(model, expected, expectedRevision)) return { action: "none" };
  model.plan = { identity, sequence: model.plan.sequence + 1 };
  if (resetBaseline && model.kind === "interval") {
    model.baseline = model.activityCount;
    model.baselineState = model.streamState;
    model.baselineGeneration = model.streamGeneration;
  }
  return identity === null
    ? { action: "clear", expectedIdentity: expected.identity, planSequence: model.plan.sequence }
    : { action: "set", identity, planSequence: model.plan.sequence };
};

const planForCurrentInputs = (model: TimerModel, preserveDeadline = false): ModuleAlarmIdentity | null => {
  if (!model.enabled) return null;
  if (model.kind === "interval") {
    const state = model.streamState === "online" ? "live" : "offline";
    const part = INTERVAL_MS;
    return identityFor(model, model.now + part, state,
      state === "live" ? model.streamId : null, model.streamGeneration);
  }
  if (model.kind === "stream_start") {
    return model.streamState === "online" && model.streamId !== null
      ? identityFor(model, model.now + INTERVAL_MS, null, model.streamId, model.streamGeneration)
      : null;
  }
  const current = currentIdentity(model);
  const deadline = preserveDeadline && current !== null && current.deadline > model.now
    ? current.deadline
    : Math.max(model.now, INITIAL_DEADLINE);
  return identityFor(model, deadline, null, null, null);
};

const createModel = (kind: TimerKind, state?: StreamState): TimerModel => {
  const initialState = state ?? (kind === "stream_start" ? "online" : "offline");
  const model: TimerModel = {
    kind,
    streamState: initialState,
    streamId: initialState === "online" ? "stream-1" : null,
    streamGeneration: initialState === "online" ? 1 : 2,
    enabled: true,
    revision: 1,
    plan: { identity: null, sequence: 0 },
    alarm: null,
    planFence: null,
    activityCount: 20,
    baseline: 10,
    baselineState: initialState,
    baselineGeneration: initialState === "online" ? 1 : 2,
    now: 0,
    posts: [],
    firstDailyDeadline: kind === "time_of_day" || kind === "before_event" ? INITIAL_DEADLINE : null,
    firstDailySent: false,
    firstDailyEligible: true,
  };
  model.plan = { identity: planForCurrentInputs(model), sequence: 1 };
  if (model.plan.identity !== null) {
    model.alarm = { identity: model.plan.identity, planSequence: model.plan.sequence };
    model.planFence = { identity: model.plan.identity, planSequence: model.plan.sequence, cleared: false };
  }
  return model;
};

const transitionStream = (model: TimerModel, state: StreamState): boolean => {
    const streamId = state === "online" ? `stream-${String(model.streamGeneration + 1)}` : null;
  if (model.streamState === state && model.streamId === streamId) return false;
  model.streamState = state;
  model.streamId = streamId;
  model.streamGeneration += 1;
  return true;
};

const startD1Step = (model: TimerModel, operation: Operation): void => {
  const expected = { ...model.plan };
  const expectedRevision = model.revision;
  if (operation.kind === "do_restart") {
    operation.pending = { action: "none" };
    return;
  }
  if (operation.kind === "event_online" || operation.kind === "event_offline" || operation.kind === "helix_transition") {
    const nextState = operation.kind === "event_online" ? "online" : operation.kind === "event_offline"
      ? "offline" : model.streamState === "online" ? "offline" : "online";
    const changed = transitionStream(model, nextState);
    if (!changed || !model.enabled || (model.kind !== "interval" && model.kind !== "stream_start")) {
      operation.pending = { action: "none" };
      return;
    }
    const identity = planForCurrentInputs(model);
    operation.pending = writePlan(model, identity, expected, expectedRevision, true);
    return;
  }
  if (operation.kind === "save_update") {
    if (!expectedPlanMatches(model, expected, expectedRevision)) {
      operation.pending = { action: "none" };
      return;
    }
    if (!model.enabled) {
      model.revision += 1;
      operation.pending = writePlan(model, null, expected, model.revision, false);
      return;
    }
    model.revision += 1;
    const identity = planForCurrentInputs(model, true);
    operation.pending = writePlan(model, identity, expected, model.revision, model.kind === "interval");
    return;
  }
  if (operation.kind === "pause_resume") {
    if (!expectedPlanMatches(model, expected, expectedRevision)) {
      operation.pending = { action: "none" };
      return;
    }
    model.enabled = !model.enabled;
    model.revision += 1;
    if (!model.enabled && model.firstDailyDeadline !== null && model.now < model.firstDailyDeadline) {
      model.firstDailyEligible = false;
    }
    const identity = planForCurrentInputs(model, true);
    operation.pending = writePlan(model, identity, expected, model.revision, model.enabled && model.kind === "interval");
    return;
  }
  const fired = operation.capturedAlarm;
  if (!model.enabled) {
    operation.pending = {
      action: "clear",
      expectedIdentity: fired?.identity ?? null,
      planSequence: model.plan.sequence,
    };
    return;
  }
  const rowIdentity = model.plan.identity;
  const alarmMatches = fired !== null && rowIdentity !== null &&
    sameTimerAlarmIdentity(fired.identity, rowIdentity) && fired.planSequence === model.plan.sequence;
  const streamPlanIsCurrent = model.kind !== "interval" && model.kind !== "stream_start" ||
    rowIdentity?.generation === model.streamGeneration &&
    rowIdentity.state === (model.kind === "interval" ? model.streamState === "online" ? "live" : "offline" : null) &&
    (model.streamState !== "online" || rowIdentity.streamId === model.streamId);
  if (!alarmMatches || !streamPlanIsCurrent) {
    const identity = planForCurrentInputs(model, true);
    operation.pending = writePlan(model, identity, expected, expectedRevision,
      model.kind === "interval" && !streamPlanIsCurrent);
    return;
  }
  if (rowIdentity.deadline > model.now) model.now = rowIdentity.deadline;
  if (model.kind === "interval") {
    const activitySinceBaseline = model.activityCount - model.baseline;
    if (activitySinceBaseline >= MINIMUM_MESSAGES && model.baselineState === model.streamState &&
        model.baselineGeneration === model.streamGeneration) {
      model.posts.push({ identity: rowIdentity, baseline: model.baseline, activity: model.activityCount,
        baselineState: model.baselineState, baselineGeneration: model.baselineGeneration });
    }
    const nextIdentity = identityFor(model, rowIdentity.deadline + INTERVAL_MS, rowIdentity.state as "live" | "offline",
      rowIdentity.streamId, rowIdentity.generation);
    operation.pending = writePlan(model, nextIdentity, expected, expectedRevision, false);
    return;
  }
  if (model.kind === "stream_start") {
    model.posts.push({ identity: rowIdentity, baseline: model.baseline, activity: model.activityCount,
      baselineState: model.baselineState, baselineGeneration: model.baselineGeneration });
    operation.pending = writePlan(model, null, expected, expectedRevision, false);
    return;
  }
  model.posts.push({ identity: rowIdentity, baseline: model.baseline, activity: model.activityCount,
    baselineState: model.baselineState, baselineGeneration: model.baselineGeneration });
  if (rowIdentity.deadline === model.firstDailyDeadline) model.firstDailySent = true;
  const nextIdentity = identityFor(model, rowIdentity.deadline + DAILY_MS, null, null, null);
  operation.pending = writePlan(model, nextIdentity, expected, expectedRevision, false);
};

const finishDoStep = (model: TimerModel, operation: Operation): void => {
  if (operation.kind === "do_restart") {
    model.alarm = model.planFence !== null && !model.planFence.cleared && model.planFence.identity !== null
      ? { identity: model.planFence.identity, planSequence: model.planFence.planSequence }
      : null;
    return;
  }
  const pending = operation.pending;
  if (pending.action === "none") return;
  const currentFence = model.planFence ?? (model.alarm === null ? undefined : model.alarm);
  if (pending.action === "set") {
    if (acceptsTimerAlarmSet(currentFence, pending.identity, pending.planSequence)) {
      model.alarm = { identity: pending.identity, planSequence: pending.planSequence };
      model.planFence = { identity: pending.identity, planSequence: pending.planSequence, cleared: false };
    }
    return;
  }
  if (acceptsTimerAlarmClear(currentFence, pending.expectedIdentity, pending.planSequence)) {
    model.alarm = null;
    model.planFence = { identity: pending.expectedIdentity, planSequence: pending.planSequence, cleared: true };
  }
};

type Step = { operation: number; phase: "d1" | "do" };

const enumerateInterleavings = (remaining: number[], prefix: Step[] = []): Step[][] => {
  if (remaining.every((count) => count === 0)) return [prefix];
  const all: Step[][] = [];
  for (let operation = 0; operation < remaining.length; operation += 1) {
    if (remaining[operation] === 0) continue;
    const next = [...remaining];
    const remainingSteps = next[operation] ?? 0;
    const phase = remainingSteps === 2 ? "d1" : "do";
    next[operation] = remainingSteps - 1;
    all.push(...enumerateInterleavings(next, [...prefix, { operation, phase }]));
  }
  return all;
};

const operationMultisets = (length: number, start = 0, prefix: OperationKind[] = []): OperationKind[][] => {
  if (prefix.length === length) return [prefix];
  const kinds: OperationKind[] = [
    "event_online", "event_offline", "helix_transition", "alarm_fire", "save_update", "pause_resume", "do_restart",
  ];
  return kinds.slice(start).flatMap((kind, index) =>
    operationMultisets(length, start + index, [...prefix, kind]));
};

const assertInvariants = (model: TimerModel): void => {
  const liveAlarms = model.alarm === null ? [] : [model.alarm];
  expect(liveAlarms.length).toBeLessThanOrEqual(1);
  if (model.plan.identity === null) {
    expect(model.alarm).toBeNull();
  } else {
    expect(model.alarm).not.toBeNull();
    expect(sameTimerAlarmIdentity(model.plan.identity, model.alarm?.identity)).toBe(true);
    expect(model.alarm?.planSequence).toBe(model.plan.sequence);
  }
  for (const post of model.posts) {
    if (model.kind === "interval") {
      expect(post.activity - post.baseline).toBeGreaterThanOrEqual(MINIMUM_MESSAGES);
      expect(post.identity.state).toBe(post.baselineState === "online" ? "live" : "offline");
      expect(post.identity.generation).toBe(post.baselineGeneration);
    }
  }
  if ((model.kind === "time_of_day" || model.kind === "before_event") && model.enabled &&
      model.firstDailyEligible && !model.firstDailySent) {
    expect(model.plan.identity?.deadline).toBe(model.firstDailyDeadline);
  }
};

const runInterleaving = (kind: TimerKind, operationKinds: OperationKind[], steps: Step[]): TimerModel => {
  const model = createModel(kind);
  const operations: Operation[] = operationKinds.map((operationKind) => ({
    kind: operationKind,
    capturedAlarm: operationKind === "alarm_fire" && model.alarm !== null ? { ...model.alarm } : null,
    pending: { action: "none" },
  }));
  for (const step of steps) {
    const operation = operations[step.operation];
    if (operation === undefined) throw new Error("Interleaving referenced a missing operation.");
    if (step.phase === "d1") startD1Step(model, operation);
    else finishDoStep(model, operation);
  }
  assertInvariants(model);
  return model;
};

describe("timer D1 and Durable Object scheduling interleavings", () => {
  it("keeps invariants across every pair and triple ordering for each timer trigger", () => {
    const kinds: TimerKind[] = ["interval", "stream_start", "time_of_day", "before_event"];
    let orderingCount = 0;
    for (const timerKind of kinds) {
      for (const operationCount of [2, 3]) {
        for (const operationKinds of operationMultisets(operationCount)) {
          for (const steps of enumerateInterleavings(Array.from({ length: operationCount }, () => 2))) {
            runInterleaving(timerKind, operationKinds, steps);
            orderingCount += 1;
          }
        }
      }
    }
    expect(orderingCount).toBe(30_912);
  });

  it("review round 4 A: offline to live to offline rearms the offline baseline before a stale alarm can post", () => {
    const model = createModel("interval", "offline");
    model.streamGeneration = 4;
    model.baselineGeneration = 4;
    model.plan.identity = identityFor(model, INITIAL_DEADLINE, "offline", null, 3);
    model.alarm = { identity: model.plan.identity, planSequence: model.plan.sequence };
    model.streamState = "offline";
    const staleAlarm = { ...model.alarm };

    transitionStream(model, "online");
    transitionStream(model, "offline");
    const operation: Operation = { kind: "alarm_fire", capturedAlarm: staleAlarm, pending: { action: "none" } };
    startD1Step(model, operation);
    finishDoStep(model, operation);

    expect(model.posts).toHaveLength(0);
    expect(model.plan.identity.generation).toBe(model.streamGeneration);
    expect(model.baseline).toBe(model.activityCount);
    assertInvariants(model);
  });

  it("review round 4 B: an old stream_start handler clear cannot erase the newer stream alarm", () => {
    const model = createModel("stream_start", "online");
    const oldAlarm = model.alarm === null ? null : { ...model.alarm };
    model.streamState = "offline";
    model.streamId = null;
    model.streamGeneration += 1;
    const staleHandler: Operation = { kind: "alarm_fire", capturedAlarm: oldAlarm, pending: { action: "none" } };
    startD1Step(model, staleHandler);
    const oldClear = staleHandler.pending;

    transitionStream(model, "online");
    const expected = { ...model.plan };
    const expectedRevision = model.revision;
    const newIdentity = planForCurrentInputs(model);
    const newWrite = writePlan(model, newIdentity, expected, expectedRevision, false);
    expect(newWrite.action).toBe("set");
    if (newWrite.action !== "set") throw new Error("New stream plan was not prepared.");
    if (acceptsTimerAlarmSet(model.planFence ?? undefined, newWrite.identity, newWrite.planSequence)) {
      model.alarm = { identity: newWrite.identity, planSequence: newWrite.planSequence };
      model.planFence = { identity: newWrite.identity, planSequence: newWrite.planSequence, cleared: false };
    }
    if (oldClear.action === "clear" &&
        acceptsTimerAlarmClear(model.planFence ?? undefined, oldClear.expectedIdentity, oldClear.planSequence)) {
      model.alarm = null;
      model.planFence = { identity: oldClear.expectedIdentity, planSequence: oldClear.planSequence, cleared: true };
    }

    expect(model.alarm?.identity.streamId).toBe(model.streamId);
    expect(model.alarm?.identity.generation).toBe(model.streamGeneration);
    assertInvariants(model);
  });
});
