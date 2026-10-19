import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { POINTS_CANCELLATION_NOTICE_ALARM_PREFIX } from "../../src/worker/durable/points";

const migrationSources = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

interface PointMovement {
  accountId: string;
  delta?: number;
  login?: string;
  potShare?: { pot: string; numerator: number; denominator: number };
}

export interface PointsWorkerObject {
  applyPointOperation(moduleId: string, operationId: string, kind: string, movements: PointMovement[], result: unknown, identity?: unknown): Promise<{
    replayed: boolean;
    result: unknown;
    balances: Record<string, number>;
  }>;
  touchPointAccount(moduleId: string, accountId: string, login: string, startBonus: number): Promise<{ welcomePending: boolean }>;
  acknowledgePointWelcome(moduleId: string, accountId: string): Promise<void>;
  pointBalance(moduleId: string, accountId: string): Promise<number>;
  pointAccount(moduleId: string, accountId: string): Promise<{ accountId: string; login: string; balance: number } | null>;
  creditPointActivity(moduleId: string, accountId: string, login: string, messageAt: number, live: boolean,
    rules: { amount: number; windowMinutes: number; dailyCap: number }): Promise<{ credited: number }>;
  listPointAccounts(moduleId: string, query: { sort: "balance" | "month"; search?: string; cursor?: string; limit: number }): Promise<{
    rows: Array<{ accountId: string; login: string; balance: number; monthNet: number | null }>;
    cursor?: string;
  }>;
  pointHistory(moduleId: string, accountId: string, cursor?: string, limit?: number): Promise<{
    rows: Array<{ operationId: string; kind: string; moduleId: string; delta: number; balanceAfter: number; at: string; detail: unknown }>;
    cursor?: string;
  }>;
  pointSummary(moduleId: string): Promise<{ circulation: number; jackpots: Record<string, number>; inRounds: number; accounts: number; month: string }>;
  pointRanking(moduleId: string, month: string, limit: number): Promise<Array<{ accountId: string; login: string; net: number }>>;
  pointRankOf(moduleId: string, accountId: string, month: string): Promise<{ rank: number | null; net: number }>;
  getPanelResourceRevisions(): Promise<Record<string, number>>;
  getActiveChatterSnapshot(userId: string): Promise<{ firstSeenAt: string; lastSeenAt: string } | null>;
  getActiveChatterCountSnapshot(windowMs: number): Promise<number>;
  readBallotSnapshot(moduleId: string, ballotId: string): Promise<unknown>;
  readBallotDryRunSnapshot(moduleId: string, ballotId: string, voterId?: string): Promise<unknown>;
  hasOpenBallotSnapshot(): Promise<boolean>;
  openGameRound(moduleId: string, roundId: string, data: unknown): Promise<void>;
  markGameRoundAnnounced(moduleId: string, roundId: string, deadlineAt: number, alarmKey: string): Promise<void>;
  joinGameRound(moduleId: string, roundId: string, operationId: string, accountId: string, login: string, stake: number, data: unknown): Promise<{
    status: "joined" | "already_joined" | "round_closed";
    replayed?: boolean;
  }>;
  resolveGameRound(moduleId: string, roundId: string, settlement: { kind: string; params: unknown }): Promise<{
    replayed: boolean;
    result: unknown;
    balances: Record<string, number>;
  }>;
  cancelOpenGameRounds(moduleId: string, revision: number): Promise<number>;
  setGameModuleGate(moduleId: string, closed: boolean, revision: number, lastDisabledRevision?: number | null): Promise<{ applied: boolean }>;
  claimGameCooldown(moduleId: string, key: string, seconds: number): Promise<boolean>;
  markPointAuditWritten(moduleId: string, operationId: string): Promise<void>;
  pendingPointAudits(moduleId: string): Promise<Array<{ operationId: string; detail: unknown }>>;
  claimPointCooldown(moduleId: string, key: string, seconds: number): Promise<boolean>;
}

const database = (env as unknown as { DB: D1Database }).DB;
const channelNamespace = (env as unknown as { CHANNEL: Env["CHANNEL"] }).CHANNEL;

export const runMigrations = async (): Promise<void> => {
  for (const path of Object.keys(migrationSources).sort((left, right) => left.localeCompare(right))) {
    const source = migrationSources[path] ?? "";
    const statements = source.split(/\r?\n/u).map((line) => line.replace(/^\s*--.*$/u, "")).join("\n").split(";");
    let trigger: string[] | null = null;
    for (const part of statements) {
      const statement = part.trim();
      if (statement.length === 0) continue;
      if (trigger !== null) {
        if (statement.toUpperCase() === "END") {
          await database.prepare(`${trigger.join(";")};${statement}`).run();
          trigger = null;
        } else trigger.push(statement);
      } else if (/^CREATE\s+TRIGGER\b/iu.test(statement)) trigger = [statement];
      else await database.prepare(statement).run();
    }
  }
};

export const insertPointChannel = async (channelId: string): Promise<void> => {
  const now = new Date().toISOString();
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, channelId, channelId, now, now).run();
};

const trackedPointObjects = new Set<DurableObjectStub>();

export const pointObject = (channelId: string): PointsWorkerObject => {
  const stub = channelNamespace.get(channelNamespace.idFromName(channelId));
  trackedPointObjects.add(stub);
  return stub as unknown as PointsWorkerObject;
};

/** Drops the platform alarm of every object a test created, so none fires after the test file ends. */
export const clearPointObjectAlarms = async (): Promise<void> => {
  const stubs = [...trackedPointObjects];
  trackedPointObjects.clear();
  await Promise.all(stubs.map((stub) => runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
  })));
};

export const pointTestModule = "test_game";

export const testCard = (protects: string, failsWhen: string, noClaim = "none beyond protects"): string =>
  `protects=${protects}; fails_when=${failsWhen}; no_claim=${noClaim}`;

export const capturePointError = async (
  object: PointsWorkerObject,
  action: (target: PointsWorkerObject) => Promise<unknown>,
): Promise<string | null> => runInDurableObject(
  object as unknown as DurableObjectStub,
  async (instance) => {
    try {
      await action(instance as unknown as PointsWorkerObject);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
);

/** The input gate waits for any in-flight alarm callback before state is edited. */
export const runPointObject = <T>(
  object: PointsWorkerObject,
  action: (target: PointsWorkerObject, state: DurableObjectState) => Promise<T> | T,
): Promise<T> => runInDurableObject(
  object as unknown as DurableObjectStub,
  (instance, state) => action(instance as unknown as PointsWorkerObject, state),
);

export const stubPointRoundChat = (
  target: PointsWorkerObject,
  sendChat: () => Promise<{
    sent: boolean;
    retryable?: boolean;
    reason?: string | null;
    attemptedAt?: number;
    delivery: "delivered" | "rate_limited" | "ambiguous" | "failed";
  }>,
): void => {
  Object.assign(target, { moduleAlarmContext: () => ({ sendChat }) });
};

export const deferPointAlarmWithin = async (state: DurableObjectState): Promise<void> => {
  await state.storage.setAlarm(Date.now() + 30 * 24 * 60 * 60_000);
};

const scheduleAlarmKeyWithin = async (
  state: DurableObjectState,
  alarmKey: string,
): Promise<void> => {
  await deferPointAlarmWithin(state);
  const table = state.storage.kv.get<Record<string, {
    deadline: number;
    handler: string;
    revision: number;
    nextAttemptAt?: number;
    claimUntil?: number;
  }>>("channel:alarm_schedule") ?? {};
  const entry = table[alarmKey];
  if (entry === undefined) throw new Error("The point round alarm was not scheduled.");
  Reflect.deleteProperty(entry, "nextAttemptAt");
  Reflect.deleteProperty(entry, "claimUntil");
  table[alarmKey] = { ...entry, deadline: Math.max(1, Date.now() - 365 * 24 * 60 * 60_000) };
  state.storage.kv.put("channel:alarm_schedule", table);
  const persistedEntry = state.storage.kv.get<typeof table>("channel:alarm_schedule")?.[alarmKey];
  if (persistedEntry === undefined || persistedEntry.deadline > Date.now()) {
    throw new Error("The point test alarm schedule was not persisted as due.");
  }
};

const schedulePointAlarmWithin = async (
  state: DurableObjectState,
  roundId: string,
): Promise<void> => scheduleAlarmKeyWithin(state, `points:round:${roundId}`);

export const schedulePointCancellationNoticeAlarmWithin = async (
  state: DurableObjectState,
  moduleId: string,
  revision: number,
): Promise<void> => scheduleAlarmKeyWithin(
  state,
  `${POINTS_CANCELLATION_NOTICE_ALARM_PREFIX}${encodeURIComponent(moduleId)}:${String(revision)}`,
);

export const runPointAlarm = async (object: PointsWorkerObject): Promise<boolean> => {
  const ran = await runDurableObjectAlarm(object as unknown as DurableObjectStub);
  if (!ran) throw new Error("The point test expected a scheduled Durable Object alarm.");
  return ran;
};

export const forcePointAlarm = async (
  object: PointsWorkerObject,
  roundId: string,
  prepare?: (target: PointsWorkerObject, state: DurableObjectState) => Promise<void> | void,
): Promise<boolean> => {
  await runPointObject(object, async (target, state) => {
    // runInDurableObject enters through the object input gate. Remove the
    // platform alarm before changing persisted test state or scheduling its one
    // explicit replacement below.
    await state.storage.deleteAlarm();
    await prepare?.(target, state);
    await schedulePointAlarmWithin(state, roundId);
  });
  return await runPointAlarm(object);
};

export const openAnnouncedRound = async (
  object: PointsWorkerObject,
  moduleId: string,
  roundId: string,
  data: unknown,
  deadlineAt: number,
): Promise<void> => runPointObject(object, async (target, state) => {
  stubPointRoundChat(target, () => Promise.resolve({ sent: false, retryable: true, reason: "rate_limited", delivery: "rate_limited" }));
  await target.openGameRound(moduleId, roundId, data);
  await target.markGameRoundAnnounced(moduleId, roundId, deadlineAt, `round:${roundId}`);
  await deferPointAlarmWithin(state);
});
