import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { blitzRoundDefaultsForLanguage } from "../../src/modules/blitz_round/locale";
import { createBlitzQuestionRepository } from "../../src/modules/blitz_round/adapters/d1";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { clearPointObjectAlarms, deferPointAlarmWithin, insertPointChannel, pointObject, runMigrations, runPointAlarm, runPointObject, testCard, type PointsWorkerObject } from "./points-test-helpers";
import { insertLoginIdentityAndSession, insertMember, testKey } from "../unit/fixtures";

const minute = 60_000;
const authKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "test-cookie", key: testKey(1).replaceAll("=", "") }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "test-encryption", key: testKey(2).replaceAll("=", "") }, retired: [] }),
};
const worker = env as unknown as { DB: D1Database; CHANNEL: Env["CHANNEL"] };
const scheduleInputsAlarm = "host:schedule_inputs_changed:activation";
const alarmScheduleKey = "channel:alarm_schedule";

interface BlitzAutoStartTestObject extends PointsWorkerObject {
  activeGameRound(moduleId: string): Promise<{ roundId: string } | null>;
}

const requestForModuleToggle = async (channelId: string, enabled: boolean, expectedRevision: number): Promise<Request> => {
  const sessionId = "session-fictional_manager";
  const cookie = await createSessionCookie({ sessionId }, authKeys.SESSION_COOKIE_KEYS, authKeys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, authKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`http://localhost/api/channels/${channelId}/modules/blitz_round`, {
    method: "PATCH",
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify({ enabled, expectedRevision }),
  });
};

const scheduledDeadline = (object: PointsWorkerObject, key: string): Promise<number | undefined> => runPointObject(object, (_target, state) =>
  state.storage.kv.get<Record<string, { deadline: number }>>(alarmScheduleKey)?.[key]?.deadline);

const fireScheduledAlarm = async (object: PointsWorkerObject, key: string): Promise<void> => {
  await runPointObject(object, async (_target, state) => {
    const table = state.storage.kv.get<Record<string, { deadline: number; handler: string; revision: number; ownerRevision?: number }>>(alarmScheduleKey) ?? {};
    const entry = table[key];
    if (entry === undefined) throw new Error(`Expected scheduled alarm ${key}.`);
    const next = { ...entry, deadline: Date.now() - 1 };
    delete (next as { claimUntil?: number }).claimUntil;
    delete (next as { nextAttemptAt?: number }).nextAttemptAt;
    table[key] = next;
    state.storage.kv.put(alarmScheduleKey, table);
    await state.storage.setAlarm(Date.now() - 1);
  });
  await runPointAlarm(object);
  await runPointObject(object, (_target, state) => deferPointAlarmWithin(state));
};

beforeAll(runMigrations);
afterEach(async () => {
  try {
    await clearPointObjectAlarms();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("Blitz auto-start through dashboard module routes", () => {
  it(`resets the live interval after the dashboard disables and re-enables Blitz (${testCard("the real module route clears the Durable Object alarm and a later enable starts its own 15 live minutes", "enable at minute 0, disable at 5, and enable at 10 still leaves the start at minute 15 instead of 25", "the panel router, channel module rows, stream state, and ChannelObject alarms are real worker components")})`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const channelId = `blitz-toggle-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const fixtureDb = worker.DB as unknown as Parameters<typeof insertLoginIdentityAndSession>[0];
    await insertLoginIdentityAndSession(fixtureDb, "fictional_manager");
    await insertMember(fixtureDb, channelId, "fictional_manager", "manager");
    await worker.DB.prepare("INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'helix')")
      .bind(channelId, new Date().toISOString()).run();
    const settings = { ...blitzRoundDefaultsForLanguage("en"), autoStart: true };
    await worker.DB.batch([
      worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision, initialized) VALUES (?, 'points', 1, '{}', 1, 1)").bind(channelId),
      worker.DB.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision, initialized) VALUES (?, 'blitz_round', 0, ?, 1, 1)").bind(channelId, JSON.stringify(settings)),
    ]);
    await createBlitzQuestionRepository(worker.DB).create(channelId, {
      kind: "quiz", prompt: "Which star is nearest?", answers: ["Sun"], enabled: true,
    }, new Date().toISOString());
    const object = pointObject(channelId);

    const enableFirst = await panelRouter.fetch(await requestForModuleToggle(channelId, true, 1), env);
    expect(enableFirst.status).toBe(200);
    await fireScheduledAlarm(object, scheduleInputsAlarm);
    expect(await scheduledDeadline(object, "module:blitz_round:auto-start")).toBe(Date.now() + 15 * minute);

    vi.advanceTimersByTime(5 * minute);
    const disable = await panelRouter.fetch(await requestForModuleToggle(channelId, false, 2), env);
    expect(disable.status).toBe(200);
    expect(await scheduledDeadline(object, "module:blitz_round:auto-start")).toBeUndefined();

    vi.advanceTimersByTime(5 * minute);
    const enableAgain = await panelRouter.fetch(await requestForModuleToggle(channelId, true, 3), env);
    expect(enableAgain.status).toBe(200);
    await fireScheduledAlarm(object, scheduleInputsAlarm);
    const deadline = await scheduledDeadline(object, "module:blitz_round:auto-start");
    expect(deadline).toBe(Date.UTC(2030, 0, 1) + 25 * minute);

    vi.advanceTimersByTime(15 * minute);
    await fireScheduledAlarm(object, "module:blitz_round:auto-start");
    const active = await runPointObject(object, (target) => (target as BlitzAutoStartTestObject).activeGameRound("blitz_round"));
    expect(active).not.toBeNull();
  });
});
