import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

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
  applyPointOperation(moduleId: string, operationId: string, kind: string, movements: PointMovement[], result: unknown): Promise<{
    replayed: boolean;
    result: unknown;
    balances: Record<string, number>;
  }>;
  touchPointAccount(moduleId: string, accountId: string, login: string, startBonus: number): Promise<{ welcomePending: boolean }>;
  acknowledgePointWelcome(moduleId: string, accountId: string): Promise<void>;
  pointBalance(moduleId: string, accountId: string): Promise<number>;
  creditPointActivity(moduleId: string, accountId: string, login: string, messageAt: number, live: boolean,
    rules: { amount: number; windowMinutes: number; dailyCap: number }): Promise<{ credited: number }>;
  listPointAccounts(moduleId: string, query: { sort: "balance" | "month"; search?: string; cursor?: string; limit: number }): Promise<{
    rows: Array<{ accountId: string; login: string; balance: number; monthNet: number }>;
    cursor?: string;
  }>;
  pointHistory(moduleId: string, accountId: string, cursor?: string, limit?: number): Promise<{
    rows: Array<{ operationId: string; kind: string; moduleId: string; delta: number; balanceAfter: number; at: string; detail: unknown }>;
    cursor?: string;
  }>;
  pointSummary(moduleId: string): Promise<{ circulation: number; jackpots: Record<string, number>; inRounds: number; accounts: number; month: string }>;
  pointRanking(moduleId: string, month: string, limit: number): Promise<Array<{ accountId: string; login: string; net: number }>>;
  pointRankOf(moduleId: string, accountId: string, month: string): Promise<{ rank: number | null; net: number }>;
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
  setGameModuleGate(moduleId: string, closed: boolean, revision: number): Promise<{ applied: boolean }>;
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

export const pointObject = (channelId: string): PointsWorkerObject =>
  channelNamespace.get(channelNamespace.idFromName(channelId)) as unknown as PointsWorkerObject;

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

export const runPointObject = <T>(
  object: PointsWorkerObject,
  action: (target: PointsWorkerObject, state: DurableObjectState) => Promise<T> | T,
): Promise<T> => runInDurableObject(
  object as unknown as DurableObjectStub,
  (instance, state) => action(instance as unknown as PointsWorkerObject, state),
);

export const stubPointRoundChat = (
  target: PointsWorkerObject,
  sendChat: () => Promise<{ sent: boolean; retryable?: boolean; reason?: string | null; attemptedAt?: number }>,
): void => {
  Object.assign(target, { moduleAlarmContext: () => ({ sendChat }) });
};

export const forcePointAlarmWithin = async (
  target: PointsWorkerObject,
  state: DurableObjectState,
  roundId: string,
): Promise<void> => {
  const alarmKey = `points:round:${roundId}`;
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
  table[alarmKey] = { ...entry, deadline: Date.now() };
  state.storage.kv.put("channel:alarm_schedule", table);
  await state.storage.setAlarm(Date.now());
  await (target as unknown as { alarm(): Promise<void> }).alarm();
};

export const openAnnouncedRound = async (
  object: PointsWorkerObject,
  moduleId: string,
  roundId: string,
  data: unknown,
  deadlineAt: number,
): Promise<void> => runPointObject(object, async (target) => {
  stubPointRoundChat(target, () => Promise.resolve({ sent: false, retryable: true, reason: "rate_limited" }));
  await target.openGameRound(moduleId, roundId, data);
  await target.markGameRoundAnnounced(moduleId, roundId, deadlineAt, `round:${roundId}`);
});
