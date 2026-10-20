import type * as BlitzService from "../../src/modules/blitz_round/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleAlarmContext, ModulePointRoundResult } from "../../src/modules/contract";
import { configureBlitzAutoStart, handleBlitzAutoStartAlarm, onBlitzRoundResolved } from "../../src/modules/blitz_round/auto-start";
import { blitzRoundDefaultsForLanguage } from "../../src/modules/blitz_round/locale";
import { loadEnabledBlitzSettings, openBlitzRound } from "../../src/modules/blitz_round/service";

vi.mock("../../src/modules/blitz_round/service", async (original) => ({
  ...await original<typeof BlitzService>(),
  loadEnabledBlitzSettings: vi.fn(),
  openBlitzRound: vi.fn(),
}));

const minute = 60_000;
const setup = () => {
  const storage = new Map<string, unknown>();
  const scheduled = new Map<string, number>();
  let online = true;
  let active: { roundId: string } | null = null;
  let activationRevision = 1;
  const context = {
    DB: {
      prepare: () => ({ bind: () => ({ first: () => Promise.resolve({ revision: activationRevision }) }) }),
    }, channelId: "fictional_channel", alarmIdentity: null,
    storage: {
      get: (key: string) => Promise.resolve(storage.get(key)),
      put: (key: string, value: unknown) => { storage.set(key, value); return Promise.resolve(); },
      delete: (key: string) => Promise.resolve(storage.delete(key)),
    },
    schedule: (key: string, deadline: number) => { scheduled.set(key, deadline); return Promise.resolve(); },
    clear: (key: string) => { scheduled.delete(key); return Promise.resolve(); },
    streamState: () => Promise.resolve(online ? "online" : "offline"),
    channelLanguage: () => Promise.resolve("en"),
    points: { rounds: { active: () => Promise.resolve(active) } },
  } as unknown as ModuleAlarmContext;
  const settings = { ...blitzRoundDefaultsForLanguage("en"), autoStart: true };
  vi.mocked(loadEnabledBlitzSettings).mockImplementation(() => Promise.resolve(settings));
  vi.mocked(openBlitzRound).mockResolvedValue({ roundId: "fictional-round" } as Awaited<ReturnType<typeof openBlitzRound>>);
  return { context, settings, storage, scheduled, setOnline: (value: boolean) => { online = value; }, setActive: (value: typeof active) => { active = value; }, setActivationRevision: (value: number) => { activationRevision = value; } };
};
const resolved = (roundId: string): ModulePointRoundResult => ({ roundId, resolvedAt: new Date().toISOString(), data: {}, result: {} });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime("2030-01-01T00:00:00.000Z"); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("blitz automatic starts", () => {
  it("pauses offline time and starts only once when the remaining interval expires [protects=offline periods pause the interval and ordinary null-identity alarms can start a round; fails_when=offline time triggers catch-up or repeated alarm delivery opens another round; no_claim=settings and round opening are mocked, not external chat delivery]", async () => {
    const fixture = setup();
    const start = Date.now();
    await configureBlitzAutoStart(fixture.context, "activation");
    expect(fixture.scheduled.get("auto-start")).toBe(start + 15 * minute);
    vi.advanceTimersByTime(5 * minute);
    fixture.setOnline(false);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    expect(fixture.scheduled.size).toBe(0);
    vi.advanceTimersByTime(90 * minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", start + 15 * minute);
    expect(openBlitzRound).not.toHaveBeenCalled();
    fixture.setOnline(true);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + 10 * minute);
    vi.advanceTimersByTime(9 * minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());
    expect(openBlitzRound).not.toHaveBeenCalled();
    vi.advanceTimersByTime(minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());
    expect(openBlitzRound).toHaveBeenCalledOnce();
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + 15 * minute);
  });

  it("waits for an active manual round and schedules from its resolution once [protects=manual starts suppress auto-start until resolution and result retries retain the original timer; fails_when=an open round overlaps auto-start or replayed resolution postpones the next start; no_claim=does not test persisted DO alarm dispatch]", async () => {
    const fixture = setup();
    await configureBlitzAutoStart(fixture.context, "activation");
    fixture.setActive({ roundId: "manual-round" });
    vi.advanceTimersByTime(15 * minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());
    expect(openBlitzRound).not.toHaveBeenCalled();
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now(), undefined, { kind: "manual_start", roundId: "manual-round" });
    fixture.setActive(null);
    const result = resolved("manual-round");
    await onBlitzRoundResolved(fixture.context, result);
    const deadline = Date.now() + 15 * minute;
    expect(fixture.scheduled.get("auto-start")).toBe(deadline);
    vi.advanceTimersByTime(2 * minute);
    await onBlitzRoundResolved(fixture.context, result);
    await configureBlitzAutoStart(fixture.context, "activation");
    expect(fixture.scheduled.get("auto-start")).toBe(deadline);
  });

  it("reconciles a cancelled round through its durable watchdog [protects=an interrupted or cancelled announcement cannot strand automatic starts; fails_when=waitingRoundId survives with no active round and no future interval; no_claim=the active-round snapshot is mocked]", async () => {
    const fixture = setup();
    fixture.setActive({ roundId: "cancelled-round" });
    await configureBlitzAutoStart(fixture.context, "activation");
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + minute);
    vi.advanceTimersByTime(minute);
    fixture.setActive(null);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + 15 * minute);
    expect(openBlitzRound).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15 * minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());
    expect(openBlitzRound).toHaveBeenCalledOnce();
  });

  it("repairs an alarm after state was persisted but scheduling failed [protects=the same resolution retry restores a lost auto-start alarm at its original deadline; fails_when=matching resolution identity prevents scheduling recovery; no_claim=uses an in-memory storage and scheduler fault]", async () => {
    const fixture = setup();
    const result = resolved("schedule-retry");
    const schedule = vi.spyOn(fixture.context, "schedule").mockRejectedValueOnce(new Error("scheduler unavailable"));
    await expect(onBlitzRoundResolved(fixture.context, result)).rejects.toThrow("scheduler unavailable");
    expect(fixture.scheduled.size).toBe(0);
    vi.advanceTimersByTime(minute);
    await onBlitzRoundResolved(fixture.context, result);
    expect(fixture.scheduled.get("auto-start")).toBe(Date.parse(result.resolvedAt) + 15 * minute);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("ignores old result retries after a newer manual round or resolution [protects=late delivery hooks cannot replace a newer timer baseline; fails_when=an old result clears a newer round wait or schedules an immediate catch-up; no_claim=does not simulate external message delivery order]", async () => {
    const fixture = setup();
    await configureBlitzAutoStart(fixture.context, "activation");
    const old = resolved("old-round");
    await onBlitzRoundResolved(fixture.context, old);
    vi.advanceTimersByTime(minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now(), undefined, { kind: "manual_start", roundId: "new-round" });
    await onBlitzRoundResolved(fixture.context, old);
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + minute);
    await onBlitzRoundResolved(fixture.context, resolved("new-round"));
    const deadline = Date.now() + 15 * minute;
    vi.advanceTimersByTime(minute);
    await onBlitzRoundResolved(fixture.context, old);
    expect(fixture.scheduled.get("auto-start")).toBe(deadline);
  });

  it("starts a full live interval when resolution occurs offline [protects=offline result processing consumes no auto-start interval; fails_when=an offline resolution delay shortens the next live interval; no_claim=does not reconstruct unavailable historical stream transitions]", async () => {
    const fixture = setup();
    fixture.setOnline(false);
    const result = resolved("offline-round");
    vi.advanceTimersByTime(5 * minute);
    await onBlitzRoundResolved(fixture.context, result);
    expect(fixture.scheduled.size).toBe(0);
    fixture.setOnline(true);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + 15 * minute);
  });

  it("keeps the recovered live remainder when a delayed resolution hook arrives [protects=an offline-to-online recovery and late result hook preserve the same round timer remainder; fails_when=a delayed hook recomputes from resolvedAt and consumes offline time; no_claim=does not exercise Durable Object alarm dispatch or external result delivery]", async () => {
    const fixture = setup();
    fixture.setActive({ roundId: "delayed-round" });
    await configureBlitzAutoStart(fixture.context, "activation");
    const result = resolved("delayed-round");

    fixture.setOnline(false);
    fixture.setActive(null);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    vi.advanceTimersByTime(60 * minute);
    fixture.setOnline(true);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    vi.advanceTimersByTime(5 * minute);
    const preservedDeadline = Date.now() + 10 * minute;

    await onBlitzRoundResolved(fixture.context, result);

    expect(fixture.scheduled.get("auto-start")).toBe(preservedDeadline);
  });

  it("keeps watchdog recovery identity through offline time and a delayed result hook [protects=watchdog reconciliation records a recovered round baseline that a later result replay cannot replace; fails_when=offline time consumes the replacement interval after a delayed hook; no_claim=uses an in-memory scheduler and does not exercise Durable Object alarm dispatch]", async () => {
    const fixture = setup();
    const round = resolved("watchdog-offline-round");
    fixture.setActive({ roundId: round.roundId });
    await configureBlitzAutoStart(fixture.context, "activation");

    vi.advanceTimersByTime(minute);
    fixture.setActive(null);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());

    vi.advanceTimersByTime(5 * minute);
    fixture.setOnline(false);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    vi.advanceTimersByTime(60 * minute);
    fixture.setOnline(true);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    const recoveredDeadline = fixture.scheduled.get("auto-start");
    expect(recoveredDeadline).toBe(Date.now() + 10 * minute);

    await onBlitzRoundResolved(fixture.context, round);

    expect(fixture.scheduled.get("auto-start")).toBe(recoveredDeadline);
  });

  it("starts a fresh interval after automatic start is disabled and enabled again [protects=each enable establishes its own live-time baseline; fails_when=the first start after enable at minute 10 fires at minute 20 instead of 25; no_claim=module settings and round opening are mocked]", async () => {
    const fixture = setup();
    await configureBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(5 * minute);
    fixture.settings.autoStart = false;
    await configureBlitzAutoStart(fixture.context, "settings");
    expect(fixture.scheduled.size).toBe(0);

    vi.advanceTimersByTime(5 * minute);
    fixture.settings.autoStart = true;
    await configureBlitzAutoStart(fixture.context, "activation");
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + 15 * minute);
    vi.advanceTimersByTime(14 * minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());
    expect(openBlitzRound).not.toHaveBeenCalled();
    vi.advanceTimersByTime(minute);
    await handleBlitzAutoStartAlarm(fixture.context, "auto-start", Date.now());
    expect(openBlitzRound).toHaveBeenCalledOnce();
  });

  it("restarts from the new activation generation even when stale scheduler state survives [protects=a changed module activation revision establishes a fresh live baseline; fails_when=an old deadline remains active after a new activation generation; no_claim=the durable state and channel module revision are mocked]", async () => {
    const fixture = setup();
    await configureBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(5 * minute);
    fixture.setActivationRevision(2);

    await configureBlitzAutoStart(fixture.context, "activation");

    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + 15 * minute);
    expect(fixture.storage.get("auto-start-state")).toMatchObject({ moduleActivationRevision: 2 });
  });

  it("uses resolution reconciliation during activation recovery [protects=activation recovery records the recovered round and fresh baseline before a delayed result hook; fails_when=the late hook replaces the activation recovery deadline; no_claim=uses an in-memory scheduler and module revision]", async () => {
    const fixture = setup();
    const round = resolved("activation-recovered-round");
    fixture.setActive({ roundId: round.roundId });
    await configureBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(5 * minute);
    fixture.setActive(null);
    fixture.setActivationRevision(2);

    await configureBlitzAutoStart(fixture.context, "activation");

    const recoveredDeadline = Date.now() + 15 * minute;
    expect(fixture.scheduled.get("auto-start")).toBe(recoveredDeadline);
    expect(fixture.storage.get("auto-start-state")).toMatchObject({
      waitingRoundId: null,
      moduleActivationRevision: 2,
      lastResolvedRoundId: round.roundId,
      lastResolvedAt: new Date(Date.now()).toISOString(),
    });

    await onBlitzRoundResolved(fixture.context, round);

    expect(fixture.scheduled.get("auto-start")).toBe(recoveredDeadline);
  });

  it("resets unsourced settings timers but keeps elapsed live time after a resolution [protects=settings saves use their own baseline before any resolution and preserve resolution timing afterward; fails_when=saving settings delays an existing resolution timer or loses paused time; no_claim=does not verify the settings HTTP revision guard]", async () => {
    const fixture = setup();
    await configureBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(5 * minute);
    await handleBlitzAutoStartAlarm(fixture.context, "settings-changed", Date.now());
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + 15 * minute);
    await onBlitzRoundResolved(fixture.context, resolved("first-round"));
    vi.advanceTimersByTime(5 * minute);
    fixture.setOnline(false);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    vi.advanceTimersByTime(60 * minute);
    fixture.settings.autoStartIntervalMinutes = 20;
    await handleBlitzAutoStartAlarm(fixture.context, "settings-changed", Date.now());
    fixture.setOnline(true);
    await configureBlitzAutoStart(fixture.context, "stream_state");
    expect(fixture.scheduled.get("auto-start")).toBe(Date.now() + 15 * minute);
    fixture.settings.autoStart = false;
    await handleBlitzAutoStartAlarm(fixture.context, "settings-changed", Date.now());
    expect(fixture.scheduled.size).toBe(0);
  });
});
