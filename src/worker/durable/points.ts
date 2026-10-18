import type {
  ModulePointsAccess,
  PointJoinResult,
  PointsApplyResult,
  PointsMovement,
  PointsKind,
} from "../../modules/contract";

export const POINTS_ROUND_ALARM_HANDLER = "host:points_round";
export const POINTS_ROUND_ALARM_PREFIX = "points:round:";
export const POINTS_CANCELLATION_NOTICE_ALARM_HANDLER = "host:points_cancellation_notice";
export const POINTS_CANCELLATION_NOTICE_ALARM_PREFIX = "points:cancellation_notice:";
export const POINTS_ANNOUNCE_RETRY_MS = 5_000;
export const POINTS_ANNOUNCE_MAX_ATTEMPTS = 6;
export const POINTS_ANNOUNCE_AMBIGUOUS_MS = 30_000;

type PointsSql = DurableObjectStorage["sql"];

interface OperationRow extends Record<string, string | number | null> {
  operation_id: string;
  module_id: string;
  kind: string;
  result_json: string;
  payload_hash: string;
  audit_state: string | null;
  created_at: string;
}

interface AccountRow extends Record<string, string | number | null> {
  account_id: string;
  kind: string;
  login: string | null;
  balance: number;
  welcome_pending: number;
}

interface RoundRow extends Record<string, string | number | null> {
  round_id: string;
  module_id: string;
  gate_revision: number;
  state: string;
  deadline_at: number | null;
  alarm_key: string | null;
  data_json: string;
  created_at: string;
  duration_s: number;
  announce_text: string;
  announce_state: string;
  announce_attempts: number;
  last_attempt_at: number | null;
}

interface ParticipantRow extends Record<string, string | number | null> {
  round_id: string;
  account_id: string;
  login: string;
  stake: number;
  data_json: string;
}

interface PointsCursor {
  sort: "balance" | "month";
  month?: string;
  value: number;
  reachedAt?: string;
  accountId: string;
}

interface HistoryCursor {
  at: string;
  operationId: string;
}

interface PointRoundOpenData {
  durationS?: number;
  duration_s?: number;
  announceText?: string;
  announce_text?: string;
  settlement?: { kind: string; params: unknown };
  [key: string]: unknown;
}

interface PointRoundParticipant {
  accountId: string;
  login: string;
  stake: number;
  data: unknown;
}

export interface PointSettlementInput {
  round: { roundId: string; moduleId: string; data: unknown };
  participants: readonly PointRoundParticipant[];
  pots: Readonly<Record<string, number>>;
  params: unknown;
}

interface PointSettlementOutput {
  movements: PointsMovement[];
  result: unknown;
}

export type PointSettlement = (input: PointSettlementInput) => PointSettlementOutput;

const POINT_ROUND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const POINT_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;
const POINT_SYSTEM_ACCOUNT_PATTERNS = [
  /^__jackpot:[A-Za-z0-9_-]{1,64}$/u,
  /^__escrow:[A-Za-z0-9_-]{1,64}$/u,
  /^__bosspot:[A-Za-z0-9_-]{1,64}$/u,
];

export const assertPointRoundId = (roundId: string): void => {
  if (!POINT_ROUND_ID_PATTERN.test(roundId)) throw new Error("invalid_round_id");
};

export const assertPointAccountId = (accountId: string): void => {
  if (!POINT_ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("invalid_account_id");
};

const allowedKinds = new Set<PointsKind>(["bonus", "activity", "stake", "game", "resolve", "refund", "admin"]);
const systemAccount = (accountId: string): boolean => accountId.startsWith("__");
const pointKindFor = (accountId: string): "viewer" | "house" | "pot" => {
  if (accountId === "__house") return "house";
  if (POINT_SYSTEM_ACCOUNT_PATTERNS.some((pattern) => pattern.test(accountId))) return "pot";
  if (systemAccount(accountId)) throw new Error("invalid_account");
  return "viewer";
};

const assertLedgerAccountId = (accountId: string): void => {
  if (systemAccount(accountId)) {
    pointKindFor(accountId);
    return;
  }
  assertPointAccountId(accountId);
};

const jsonValue = (value: unknown): string => {
  const serialized: unknown = JSON.stringify(value);
  return typeof serialized === "string" ? serialized : "null";
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort((left, right) => left.localeCompare(right))
    .filter((key) => record[key] !== undefined)
    .map((key) => [key, stableValue(record[key])]));
};

export const pointPayloadHash = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(jsonValue(stableValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const ensurePointsSchema = (sql: PointsSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS point_operations (
    operation_id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    result_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    audit_state TEXT,
    created_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS point_accounts (
    account_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    login TEXT,
    balance INTEGER NOT NULL CHECK (account_id = '__house' OR balance >= 0),
    welcome_pending INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS point_ledger (
    operation_id TEXT NOT NULL REFERENCES point_operations(operation_id),
    account_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    PRIMARY KEY (operation_id, account_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS point_monthly (
    account_id TEXT NOT NULL,
    month TEXT NOT NULL,
    net_won INTEGER NOT NULL,
    reached_at TEXT NOT NULL,
    PRIMARY KEY (account_id, month)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS game_rounds (
    round_id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    gate_revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    deadline_at INTEGER,
    alarm_key TEXT,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    duration_s INTEGER NOT NULL,
    announce_text TEXT NOT NULL,
    announce_state TEXT NOT NULL,
    announce_attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS game_round_participants (
    round_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    login TEXT NOT NULL,
    stake INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (round_id, account_id)
  )`);
  sql.exec("CREATE TABLE IF NOT EXISTS game_cooldowns (key TEXT PRIMARY KEY, until_at TEXT NOT NULL)");
  sql.exec(`CREATE TABLE IF NOT EXISTS activity_days (
    account_id TEXT NOT NULL,
    day TEXT NOT NULL,
    credited INTEGER NOT NULL,
    last_window TEXT NOT NULL,
    PRIMARY KEY (account_id, day)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS module_gates (
    module_id TEXT PRIMARY KEY,
    closed INTEGER NOT NULL,
    revision INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS game_round_cancellations (
    module_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS game_round_cancellation_notices (
    module_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (module_id, revision)
  )`);
  const gameRoundColumns = sql.exec<{ name: string }>("PRAGMA table_info(game_rounds)").toArray();
  if (!gameRoundColumns.some(({ name }) => name === "gate_revision")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN gate_revision INTEGER NOT NULL DEFAULT 0");
    sql.exec(`UPDATE game_rounds
                 SET gate_revision = COALESCE(
                   CASE WHEN state IN ('announcing', 'open', 'resolving') THEN
                     (SELECT revision - 1 FROM game_round_cancellations
                       WHERE game_round_cancellations.module_id = game_rounds.module_id)
                   END,
                   (SELECT revision FROM module_gates WHERE module_gates.module_id = game_rounds.module_id),
                   0
                 )`);
  }
  sql.exec("CREATE INDEX IF NOT EXISTS point_accounts_balance ON point_accounts (kind, balance DESC)");
  sql.exec("CREATE INDEX IF NOT EXISTS point_monthly_rank ON point_monthly (month, net_won DESC, reached_at ASC, account_id ASC)");
  sql.exec("CREATE INDEX IF NOT EXISTS point_ledger_account_history ON point_ledger (account_id, operation_id)");
  sql.exec("CREATE INDEX IF NOT EXISTS game_rounds_module_state ON game_rounds (module_id, state)");
};

const ensureAccountSync = (sql: PointsSql, accountId: string, login: string | null, now: string): AccountRow => {
  assertLedgerAccountId(accountId);
  const kind = pointKindFor(accountId);
  sql.exec(
    `INSERT INTO point_accounts (account_id, kind, login, balance, welcome_pending, updated_at)
     VALUES (?, ?, ?, 0, 0, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       login = CASE WHEN excluded.login IS NULL THEN point_accounts.login ELSE excluded.login END,
       updated_at = CASE WHEN excluded.login IS NULL THEN point_accounts.updated_at ELSE excluded.updated_at END`,
    accountId,
    kind,
    login,
    now,
  );
  const account = sql.exec<AccountRow>(
    "SELECT account_id, kind, login, balance, welcome_pending FROM point_accounts WHERE account_id = ?",
    accountId,
  ).one();
  if (account.kind !== kind) throw new Error("account_kind_conflict");
  return account;
};

const checkModuleGateSync = (sql: PointsSql, moduleId: string): void => {
  const gate = sql.exec<{ closed: number }>("SELECT closed FROM module_gates WHERE module_id = ?", moduleId).toArray()[0];
  if (gate?.closed === 1) throw new Error("module_closed");
};

const operationSync = (sql: PointsSql, operationId: string): OperationRow | null =>
  sql.exec<OperationRow>(
    `SELECT operation_id, module_id, kind, result_json, payload_hash, audit_state, created_at
       FROM point_operations WHERE operation_id = ?`,
    operationId,
  ).toArray()[0] ?? null;

const recordedBalancesSync = (sql: PointsSql, operationId: string): Record<string, number> => {
  const rows = sql.exec<{ account_id: string; balance: number }>(
    "SELECT ledger.account_id, account.balance FROM point_ledger AS ledger JOIN point_accounts AS account USING (account_id) WHERE operation_id = ?",
    operationId,
  ).toArray();
  return Object.fromEntries(rows.map(({ account_id, balance }) => [account_id, balance]));
};

const incrementMonthlySync = (sql: PointsSql, accountId: string, month: string, net: number, at: string): void => {
  sql.exec(
    `INSERT INTO point_monthly (account_id, month, net_won, reached_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, month) DO UPDATE SET
       net_won = net_won + excluded.net_won,
       reached_at = CASE WHEN excluded.net_won = 0 THEN point_monthly.reached_at ELSE excluded.reached_at END`,
    accountId,
    month,
    net,
    at,
  );
};

const expandedMovementsSync = (
  sql: PointsSql,
  movements: readonly PointsMovement[],
  now: string,
): Map<string, number> => {
  const deltas = new Map<string, number>();
  const running = new Map<string, number>();
  const currentBalance = (accountId: string): number => {
    const cached = running.get(accountId);
    if (cached !== undefined) return cached;
    const row = ensureAccountSync(sql, accountId, null, now);
    running.set(accountId, row.balance);
    return row.balance;
  };
  const addSegment = (segment: Map<string, { delta: number; login: string | null }>): void => {
    for (const [accountId, movement] of segment) {
      if (movement.delta === 0) continue;
      const next = currentBalance(accountId) + movement.delta;
      if (!Number.isSafeInteger(next)) throw new Error("balance_overflow");
      running.set(accountId, next);
      deltas.set(accountId, (deltas.get(accountId) ?? 0) + movement.delta);
      if (movement.login !== null) ensureAccountSync(sql, accountId, movement.login, now);
    }
  };
  let segment = new Map<string, { delta: number; login: string | null }>();
  for (const movement of movements) {
    if ("delta" in movement) {
      if (!Number.isSafeInteger(movement.delta)) throw new Error("invalid_movement");
      const existing = segment.get(movement.accountId);
      segment.set(movement.accountId, {
        delta: (existing?.delta ?? 0) + movement.delta,
        login: movement.login ?? existing?.login ?? null,
      });
      continue;
    }
    addSegment(segment);
    segment = new Map();
    const { pot, numerator, denominator } = movement.potShare;
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator < 1 || numerator > denominator) {
      throw new Error("invalid_pot_share");
    }
    if (pointKindFor(pot) !== "pot") throw new Error("invalid_pot_share");
    if (pointKindFor(movement.accountId) !== "viewer") throw new Error("invalid_pot_share");
    const shareBigInt = BigInt(Math.max(0, currentBalance(pot))) * BigInt(numerator) / BigInt(denominator);
    const share = Number(shareBigInt);
    if (!Number.isSafeInteger(share)) throw new Error("balance_overflow");
    if (share > 0) {
      const viewerBalance = currentBalance(movement.accountId);
      const nextViewerBalance = viewerBalance + share;
      if (!Number.isSafeInteger(nextViewerBalance)) throw new Error("balance_overflow");
      running.set(pot, currentBalance(pot) - share);
      running.set(movement.accountId, nextViewerBalance);
      deltas.set(pot, (deltas.get(pot) ?? 0) - share);
      deltas.set(movement.accountId, (deltas.get(movement.accountId) ?? 0) + share);
    }
  }
  addSegment(segment);
  return deltas;
};

const invariantSync = (sql: PointsSql): void => {
  const sum = sql.exec<{ balance_sum: number }>("SELECT COALESCE(SUM(balance), 0) AS balance_sum FROM point_accounts").one().balance_sum;
  if (sum !== 0) throw new Error("ledger_invariant");
};

export interface PointApplyInternalResult extends PointsApplyResult {
  deltas: Record<string, number>;
}

export const applyPointOperationSync = (
  sql: PointsSql,
  moduleId: string,
  operationId: string,
  kind: PointsKind,
  movements: readonly PointsMovement[],
  result: unknown,
  payloadHash: string,
  now: string,
): PointApplyInternalResult => {
  if (!allowedKinds.has(kind)) throw new Error("invalid_operation_kind");
  if (operationId.length === 0 || operationId.length > 200) throw new Error("invalid_operation_id");
  for (const movement of movements) {
    assertLedgerAccountId(movement.accountId);
    if ("potShare" in movement) assertLedgerAccountId(movement.potShare.pot);
  }
  if (kind === "game") checkModuleGateSync(sql, moduleId);
  const previous = operationSync(sql, operationId);
  if (previous !== null) {
    if (previous.payload_hash !== payloadHash) throw new Error("operation_conflict");
    const deltas = Object.fromEntries(sql.exec<{ account_id: string; delta: number }>(
      "SELECT account_id, delta FROM point_ledger WHERE operation_id = ?", operationId,
    ).toArray().map(({ account_id, delta }) => [account_id, delta]));
    return { replayed: true, result: JSON.parse(previous.result_json) as unknown, balances: recordedBalancesSync(sql, operationId), deltas };
  }

  const gameAccounts = new Set<string>();
  if (kind === "game") {
    for (const movement of movements) {
      if (!movement.accountId.startsWith("__")) gameAccounts.add(movement.accountId);
    }
  }
  const deltas = expandedMovementsSync(sql, movements, now);
  for (const [accountId, delta] of deltas) {
    if (!Number.isSafeInteger(delta)) throw new Error("invalid_movement");
    ensureAccountSync(sql, accountId, null, now);
  }
  const total = [...deltas.values()].reduce((sum, delta) => sum + delta, 0);
  if (total !== 0) throw new Error("ledger_not_zero_sum");

  const finalBalances = new Map<string, number>();
  for (const [accountId, delta] of deltas) {
    const account = sql.exec<AccountRow>(
      "SELECT account_id, kind, login, balance, welcome_pending FROM point_accounts WHERE account_id = ?",
      accountId,
    ).one();
    const balance = account.balance + delta;
    if (!Number.isSafeInteger(balance)) throw new Error("balance_overflow");
    if (accountId !== "__house" && balance < 0) throw new Error("insufficient_balance");
    finalBalances.set(accountId, balance);
  }

  sql.exec(
    `INSERT INTO point_operations (operation_id, module_id, kind, result_json, payload_hash, audit_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    operationId,
    moduleId,
    kind,
    jsonValue(result),
    payloadHash,
    kind === "admin" ? "pending" : null,
    now,
  );
  for (const [accountId, delta] of deltas) {
    const balance = finalBalances.get(accountId);
    if (balance === undefined || delta === 0) continue;
    sql.exec("UPDATE point_accounts SET balance = ?, updated_at = ? WHERE account_id = ?", balance, now, accountId);
    sql.exec(
      "INSERT INTO point_ledger (operation_id, account_id, delta, balance_after) VALUES (?, ?, ?, ?)",
      operationId,
      accountId,
      delta,
      balance,
    );
  }
  if (kind === "game") {
    const month = now.slice(0, 7);
    for (const accountId of gameAccounts) incrementMonthlySync(sql, accountId, month, deltas.get(accountId) ?? 0, now);
  }
  invariantSync(sql);
  return {
    replayed: false,
    result,
    balances: Object.fromEntries(finalBalances),
    deltas: Object.fromEntries(deltas),
  };
};

export const touchPointAccountSync = (
  sql: PointsSql,
  moduleId: string,
  accountId: string,
  login: string,
  startBonus: number,
  bonusHash: string,
  now: string,
): { welcomePending: boolean } => {
  if (pointKindFor(accountId) !== "viewer" || login.length === 0 || !Number.isSafeInteger(startBonus) || startBonus < 0) {
    throw new Error("invalid_account");
  }
  const existing = sql.exec<AccountRow>(
    "SELECT account_id, kind, login, balance, welcome_pending FROM point_accounts WHERE account_id = ?",
    accountId,
  ).toArray()[0];
  if (existing === undefined) {
    ensureAccountSync(sql, accountId, login, now);
    applyPointOperationSync(sql, moduleId, `bonus:${accountId}`, "bonus", [
      { accountId, delta: startBonus, login },
      { accountId: "__house", delta: -startBonus },
    ], { amount: startBonus }, bonusHash, now);
    sql.exec("UPDATE point_accounts SET welcome_pending = 1, login = ?, updated_at = ? WHERE account_id = ?", login, now, accountId);
    invariantSync(sql);
    return { welcomePending: true };
  }
  if (existing.kind !== "viewer") throw new Error("account_kind_conflict");
  sql.exec("UPDATE point_accounts SET login = ?, updated_at = ? WHERE account_id = ?", login, now, accountId);
  return { welcomePending: existing.welcome_pending === 1 };
};

export const creditPointActivitySync = (
  sql: PointsSql,
  moduleId: string,
  accountId: string,
  login: string,
  messageAt: number,
  live: boolean,
  rules: { amount: number; windowMinutes: number; dailyCap: number },
  activityHash: (operationId: string, credited: number) => string,
  now: string,
): { credited: number } => {
  if (!Number.isFinite(messageAt) || !Number.isSafeInteger(rules.amount) || rules.amount < 0 ||
      !Number.isSafeInteger(rules.windowMinutes) || rules.windowMinutes < 1 ||
      !Number.isSafeInteger(rules.dailyCap) || rules.dailyCap < 0 || pointKindFor(accountId) !== "viewer") {
    throw new Error("invalid_activity_rules");
  }
  const day = new Date(messageAt).toISOString().slice(0, 10);
  const windowMs = rules.windowMinutes * 60_000;
  const windowStart = Math.floor(messageAt / windowMs) * windowMs;
  const window = String(windowStart);
  const operationId = `activity:${accountId}:${window}`;
  const previousOperation = operationSync(sql, operationId);
  if (previousOperation !== null) {
    const delta = sql.exec<{ delta: number }>(
      "SELECT delta FROM point_ledger WHERE operation_id = ? AND account_id = ?",
      operationId,
      accountId,
    ).toArray()[0]?.delta ?? 0;
    if (previousOperation.payload_hash !== activityHash(operationId, Math.max(0, delta))) throw new Error("operation_conflict");
    return { credited: 0 };
  }
  const previous = sql.exec<{ credited: number; last_window: string }>(
    "SELECT credited, last_window FROM activity_days WHERE account_id = ? AND day = ?",
    accountId,
    day,
  ).toArray()[0];
  if (!live || previous?.last_window === window) return { credited: 0 };
  const credited = Math.min(rules.amount, Math.max(0, rules.dailyCap - (previous?.credited ?? 0)));
  const messageNow = new Date(messageAt).toISOString();
  applyPointOperationSync(sql, moduleId, operationId, "activity", [
    { accountId, delta: credited, login },
    { accountId: "__house", delta: -credited },
  ], { credited, messageAt: messageNow }, activityHash(operationId, credited), now);
  sql.exec(
    `INSERT INTO activity_days (account_id, day, credited, last_window) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, day) DO UPDATE SET credited = credited + excluded.credited, last_window = excluded.last_window`,
    accountId,
    day,
    credited,
    window,
  );
  return { credited };
};

const decodeCursor = (cursor: string | undefined): PointsCursor | HistoryCursor | null => {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(cursor));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid_cursor");
    const fields = parsed as Record<string, unknown>;
    if (typeof fields.at === "string" && typeof fields.operationId === "string") {
      return fields as unknown as HistoryCursor;
    }
    if ((fields.sort === "balance" || fields.sort === "month") && typeof fields.value === "number" &&
        typeof fields.accountId === "string") {
      return fields as unknown as PointsCursor;
    }
    throw new Error("invalid_cursor");
  } catch {
    throw new Error("invalid_cursor");
  }
};

const encodeCursor = (cursor: PointsCursor | HistoryCursor): string => encodeURIComponent(JSON.stringify(cursor));

export const listPointAccounts = (
  sql: PointsSql,
  query: { sort: "balance" | "month"; search?: string; cursor?: string; limit: number },
  month: string,
): Awaited<ReturnType<ModulePointsAccess["listAccounts"]>> => {
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit)));
  const cursor = decodeCursor(query.cursor) as PointsCursor | null;
  if (cursor !== null && cursor.sort !== query.sort) throw new Error("invalid_cursor");
  if (cursor?.sort === "month" && cursor.month !== month) throw new Error("invalid_cursor");
  const conditions = ["account.kind = 'viewer'"];
  const values: Array<string | number> = [];
  if (query.search !== undefined && query.search.trim().length > 0) {
    conditions.push("(lower(account.login) LIKE ? OR lower(account.account_id) LIKE ?)");
    const pattern = `%${query.search.trim().toLowerCase()}%`;
    values.push(pattern, pattern);
  }
  if (cursor !== null && query.sort === "balance") {
    conditions.push("(account.balance < ? OR (account.balance = ? AND account.account_id > ?))");
    values.push(cursor.value, cursor.value, cursor.accountId);
  } else if (cursor !== null && query.sort === "month") {
    conditions.push(`(COALESCE(monthly.net_won, 0) < ? OR
      (COALESCE(monthly.net_won, 0) = ? AND COALESCE(monthly.reached_at, '') > ?) OR
      (COALESCE(monthly.net_won, 0) = ? AND COALESCE(monthly.reached_at, '') = ? AND account.account_id > ?))`);
    values.push(cursor.value, cursor.value, cursor.reachedAt ?? "", cursor.value, cursor.reachedAt ?? "", cursor.accountId);
  }
  const monthJoin = query.sort === "month" ? "LEFT JOIN point_monthly AS monthly ON monthly.account_id = account.account_id AND monthly.month = ?" : "LEFT JOIN point_monthly AS monthly ON monthly.account_id = account.account_id AND monthly.month = ?";
  values.unshift(month);
  const rows = sql.exec<{
    account_id: string;
    login: string | null;
    balance: number;
    month_net: number | null;
    reached_at: string | null;
  }>(
    `SELECT account.account_id, account.login, account.balance, monthly.net_won AS month_net, monthly.reached_at
       FROM point_accounts AS account ${monthJoin}
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${query.sort === "balance" ? "account.balance DESC, account.account_id ASC" : "COALESCE(monthly.net_won, 0) DESC, COALESCE(monthly.reached_at, '') ASC, account.account_id ASC"}
      LIMIT ?`,
    ...values,
    limit + 1,
  ).toArray();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = hasMore && last !== undefined
    ? encodeCursor({
      sort: query.sort,
      ...(query.sort === "month" ? { month } : {}),
      value: query.sort === "balance" ? last.balance : last.month_net ?? 0,
      ...(query.sort === "month" ? { reachedAt: last.reached_at ?? "" } : {}),
      accountId: last.account_id,
    })
    : undefined;
  return {
    rows: page.map((row) => ({
      accountId: row.account_id,
      login: row.login ?? row.account_id,
      balance: row.balance,
      monthNet: row.month_net ?? 0,
    })),
    ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
  };
};

export const pointHistory = (
  sql: PointsSql,
  accountId: string,
  cursorValue: string | undefined,
  limitValue: number | undefined,
): Awaited<ReturnType<ModulePointsAccess["history"]>> => {
  const limit = Math.max(1, Math.min(100, Math.trunc(limitValue ?? 50)));
  const cursor = decodeCursor(cursorValue) as HistoryCursor | null;
  const cursorWhere = cursor === null ? "" : "AND (operation.created_at < ? OR (operation.created_at = ? AND operation.operation_id < ?))";
  const values: Array<string | number> = cursor === null
    ? [accountId, limit + 1]
    : [accountId, cursor.at, cursor.at, cursor.operationId, limit + 1];
  const rows = sql.exec<{
    operation_id: string;
    kind: string;
    module_id: string;
    delta: number;
    balance_after: number;
    created_at: string;
    result_json: string;
  }>(
    `SELECT operation.operation_id, operation.kind, operation.module_id, ledger.delta,
            ledger.balance_after, operation.created_at, operation.result_json
       FROM point_ledger AS ledger
       JOIN point_operations AS operation USING (operation_id)
      WHERE ledger.account_id = ? ${cursorWhere}
      ORDER BY operation.created_at DESC, operation.operation_id DESC
      LIMIT ?`,
    ...values,
  ).toArray();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((row) => ({
      operationId: row.operation_id,
      kind: row.kind,
      moduleId: row.module_id,
      delta: row.delta,
      balanceAfter: row.balance_after,
      at: row.created_at,
      detail: JSON.parse(row.result_json) as unknown,
    })),
    ...(hasMore && last !== undefined ? { cursor: encodeCursor({ at: last.created_at, operationId: last.operation_id }) } : {}),
  };
};

export const pointSummary = (sql: PointsSql): Awaited<ReturnType<ModulePointsAccess["summary"]>> => {
  const house = sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = '__house'").toArray()[0]?.balance ?? 0;
  const jackpots = sql.exec<{ account_id: string; balance: number }>(
    "SELECT account_id, balance FROM point_accounts WHERE substr(account_id, 1, 10) = '__jackpot:' ORDER BY account_id",
  ).toArray();
  const inRounds = sql.exec<{ balance: number }>(
    "SELECT COALESCE(SUM(balance), 0) AS balance FROM point_accounts WHERE substr(account_id, 1, 9) = '__escrow:' OR substr(account_id, 1, 10) = '__bosspot:'",
  ).one().balance;
  const viewers = sql.exec<{ accounts: number }>("SELECT COUNT(*) AS accounts FROM point_accounts WHERE kind = 'viewer'").one().accounts;
  return {
    circulation: Math.max(0, -house),
    jackpots: Object.fromEntries(jackpots.map((row) => [row.account_id.slice("__jackpot:".length), row.balance])),
    inRounds,
    accounts: viewers,
    month: new Date().toISOString().slice(0, 7),
  };
};

export const pointRanking = (
  sql: PointsSql,
  month: string,
  limitValue: number,
): Awaited<ReturnType<ModulePointsAccess["ranking"]>> => {
  const limit = Math.max(1, Math.min(500, Math.trunc(limitValue)));
  return sql.exec<{ account_id: string; login: string | null; net_won: number }>(
    `SELECT monthly.account_id, account.login, monthly.net_won
       FROM point_monthly AS monthly
       JOIN point_accounts AS account ON account.account_id = monthly.account_id AND account.kind = 'viewer'
      WHERE monthly.month = ?
      ORDER BY monthly.net_won DESC, monthly.reached_at ASC, monthly.account_id ASC
      LIMIT ?`,
    month,
    limit,
  ).toArray().map((row) => ({ accountId: row.account_id, login: row.login ?? row.account_id, net: row.net_won }));
};

export const pointRankOf = (
  sql: PointsSql,
  accountId: string,
  month: string,
): Awaited<ReturnType<ModulePointsAccess["rankOf"]>> => {
  const current = sql.exec<{ net_won: number; reached_at: string }>(
    "SELECT net_won, reached_at FROM point_monthly WHERE account_id = ? AND month = ?",
    accountId,
    month,
  ).toArray()[0];
  if (current === undefined) return { rank: null, net: 0 };
  const ahead = sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count FROM point_monthly
      WHERE month = ? AND (
        net_won > ? OR
        (net_won = ? AND reached_at < ?) OR
        (net_won = ? AND reached_at = ? AND account_id < ?)
      )`,
    month,
    current.net_won,
    current.net_won,
    current.reached_at,
    current.net_won,
    current.reached_at,
    accountId,
  ).one().count;
  return { rank: ahead + 1, net: current.net_won };
};

export const pointBalance = (sql: PointsSql, accountId: string): number =>
  sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", accountId).toArray()[0]?.balance ?? 0;

export const acknowledgeWelcomeSync = (sql: PointsSql, accountId: string, now: string): void => {
  sql.exec("UPDATE point_accounts SET welcome_pending = 0, updated_at = ? WHERE account_id = ?", now, accountId);
};

export const pointAuditWrittenSync = (sql: PointsSql, moduleId: string, operationId: string): void => {
  sql.exec("UPDATE point_operations SET audit_state = 'written' WHERE operation_id = ? AND module_id = ? AND kind = 'admin'", operationId, moduleId);
};

export const pendingPointAudits = (sql: PointsSql, moduleId: string): Awaited<ReturnType<ModulePointsAccess["pendingAudits"]>> =>
  sql.exec<{ operation_id: string; result_json: string }>(
    `SELECT operation_id, result_json FROM point_operations
      WHERE module_id = ? AND kind = 'admin' AND audit_state = 'pending' ORDER BY created_at, operation_id`,
    moduleId,
  ).toArray().map((row) => ({ operationId: row.operation_id, detail: JSON.parse(row.result_json) as unknown }));

export const setGameModuleGateSync = (
  sql: PointsSql,
  moduleId: string,
  closed: boolean,
  revision: number,
  hashFor: (value: unknown) => string,
  now = new Date().toISOString(),
): { applied: boolean } => {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_revision");
  const existing = sql.exec<{ revision: number; closed: number }>(
    "SELECT revision, closed FROM module_gates WHERE module_id = ?",
    moduleId,
  ).toArray()[0];
  if (existing !== undefined && revision <= existing.revision) return { applied: false };
  if (!closed) {
    const cancellation = sql.exec<{ revision: number }>(
      "SELECT revision FROM game_round_cancellations WHERE module_id = ?",
      moduleId,
    ).toArray()[0];
    if (cancellation !== undefined) {
      const roundIds = sql.exec<{ round_id: string }>(
        `SELECT round_id FROM game_rounds WHERE module_id = ? AND state IN ('announcing', 'open', 'resolving') ORDER BY created_at, round_id`,
        moduleId,
      ).toArray().map(({ round_id }) => round_id);
      cancelPointRoundsSync(
        sql,
        moduleId,
        now,
        hashFor,
        roundIds,
        cancellation.revision,
      );
    }
  }
  sql.exec(
    `INSERT INTO module_gates (module_id, closed, revision) VALUES (?, ?, ?)
     ON CONFLICT(module_id) DO UPDATE SET closed = excluded.closed, revision = excluded.revision`,
    moduleId,
    closed ? 1 : 0,
    revision,
  );
  if (closed) {
    sql.exec(
      `INSERT INTO game_round_cancellations (module_id, revision) VALUES (?, ?)
       ON CONFLICT(module_id) DO UPDATE SET revision = excluded.revision`,
      moduleId,
      revision,
    );
  } else {
    sql.exec("DELETE FROM game_round_cancellations WHERE module_id = ?", moduleId);
  }
  return { applied: true };
};

export const pendingPointRoundCancellations = (sql: PointsSql): Array<{ moduleId: string; revision: number }> =>
  sql.exec<{ module_id: string; revision: number }>(
    "SELECT module_id, revision FROM game_round_cancellations ORDER BY module_id",
  ).toArray().map(({ module_id, revision }) => ({ moduleId: module_id, revision }));

export const pendingPointRoundCancellationNotices = (sql: PointsSql): Array<{ moduleId: string; revision: number }> =>
  sql.exec<{ module_id: string; revision: number }>(
    `SELECT module_id, revision FROM game_round_cancellation_notices
      WHERE completed_at IS NULL ORDER BY created_at, module_id, revision`,
  ).toArray().map(({ module_id, revision }) => ({ moduleId: module_id, revision }));

export const completePointRoundCancellationNoticeSync = (
  sql: PointsSql,
  moduleId: string,
  revision: number,
  completedAt: string,
): void => {
  sql.exec(
    `UPDATE game_round_cancellation_notices SET completed_at = ?
      WHERE module_id = ? AND revision = ? AND completed_at IS NULL`,
    completedAt,
    moduleId,
    revision,
  );
};

export const claimPointCooldownSync = (sql: PointsSql, moduleId: string, key: string, seconds: number, now: number): boolean => {
  if (key.length === 0 || !Number.isSafeInteger(seconds) || seconds < 0) throw new Error("invalid_cooldown");
  const fullKey = `${moduleId}:${key}`;
  const previous = sql.exec<{ until_at: string }>("SELECT until_at FROM game_cooldowns WHERE key = ?", fullKey).toArray()[0];
  if (previous !== undefined && Date.parse(previous.until_at) > now) return false;
  const until = new Date(now + seconds * 1_000).toISOString();
  sql.exec(
    `INSERT INTO game_cooldowns (key, until_at) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET until_at = excluded.until_at`,
    fullKey,
    until,
  );
  return true;
};

const parseRoundOpenData = (value: unknown): { data: unknown; durationS: number; announceText: string; settlement: { kind: string; params: unknown } } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_round");
  const data = value as PointRoundOpenData;
  const durationS = data.durationS ?? data.duration_s;
  const announceText = data.announceText ?? data.announce_text;
  if (!Number.isSafeInteger(durationS) || (durationS ?? 0) < 1 || (durationS ?? 0) > 86_400 || typeof announceText !== "string" || announceText.length === 0) {
    throw new Error("invalid_round");
  }
  const rawSettlement: unknown = (value as Record<string, unknown>).settlement;
  if (typeof rawSettlement !== "object" || rawSettlement === null || Array.isArray(rawSettlement) ||
      typeof (rawSettlement as { kind?: unknown }).kind !== "string" ||
      (rawSettlement as { kind: string }).kind.length === 0) {
    throw new Error("settlement_unknown");
  }
  return { data, durationS: durationS as number, announceText, settlement: rawSettlement as { kind: string; params: unknown } };
};

export const pointRoundAlarmKey = (roundId: string): string => `${POINTS_ROUND_ALARM_PREFIX}${roundId}`;

export const pointRoundRow = (sql: PointsSql, roundId: string): RoundRow | null =>
  sql.exec<RoundRow>(
    `SELECT round_id, module_id, gate_revision, state, deadline_at, alarm_key, data_json, created_at, duration_s,
            announce_text, announce_state, announce_attempts, last_attempt_at
       FROM game_rounds WHERE round_id = ?`,
    roundId,
  ).toArray()[0] ?? null;

export const openPointRoundSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  value: unknown,
  now: string,
  settlements: ReadonlyMap<string, PointSettlement>,
): { opened: boolean; alarmKey: string } => {
  assertPointRoundId(roundId);
  const gate = sql.exec<{ closed: number; revision: number }>(
    "SELECT closed, revision FROM module_gates WHERE module_id = ?",
    moduleId,
  ).toArray()[0];
  if (gate?.closed === 1) throw new Error("module_closed");
  const parsed = parseRoundOpenData(value);
  if (!settlements.has(parsed.settlement.kind)) throw new Error("settlement_unknown");
  const dataJson = jsonValue(stableValue(parsed.data));
  const previous = pointRoundRow(sql, roundId);
  if (previous !== null) {
    if (previous.module_id !== moduleId || previous.data_json !== dataJson) throw new Error("round_conflict");
    return { opened: false, alarmKey: previous.alarm_key ?? pointRoundAlarmKey(roundId) };
  }
  const alarmKey = pointRoundAlarmKey(roundId);
  sql.exec(
    `INSERT INTO game_rounds
      (round_id, module_id, gate_revision, state, deadline_at, alarm_key, data_json, created_at, duration_s,
       announce_text, announce_state, announce_attempts, last_attempt_at)
     VALUES (?, ?, ?, 'announcing', NULL, ?, ?, ?, ?, ?, 'pending', 0, NULL)`,
    roundId,
    moduleId,
    gate?.revision ?? 0,
    alarmKey,
    dataJson,
    now,
    parsed.durationS,
    parsed.announceText,
  );
  return { opened: true, alarmKey };
};

export const markPointRoundAnnouncedSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  deadlineAt: number,
  alarmKey: string,
): void => {
  assertPointRoundId(roundId);
  if (!Number.isFinite(deadlineAt)) throw new Error("invalid_deadline");
  const row = pointRoundRow(sql, roundId);
  if (row === null || row.module_id !== moduleId) throw new Error("round_not_found");
  if (row.state === "open" && row.deadline_at === deadlineAt) return;
  if (row.state !== "announcing") throw new Error("round_closed");
  sql.exec(
    `UPDATE game_rounds SET state = 'open', announce_state = 'delivered', deadline_at = ?, alarm_key = ?
      WHERE round_id = ? AND module_id = ? AND state = 'announcing'`,
    deadlineAt,
    alarmKey,
    roundId,
    moduleId,
  );
};

const participantsForRoundSync = (sql: PointsSql, roundId: string): PointRoundParticipant[] =>
  sql.exec<ParticipantRow>(
    `SELECT round_id, account_id, login, stake, data_json FROM game_round_participants
      WHERE round_id = ? ORDER BY account_id`,
    roundId,
  ).toArray().map((row) => ({
    accountId: row.account_id,
    login: row.login,
    stake: row.stake,
    data: JSON.parse(row.data_json) as unknown,
  }));

export interface PointRefundRequest {
  moduleId: string;
  operationId: string;
  movements: PointsMovement[];
  result: unknown;
  roundId: string;
}

export const pointRoundRefundRequests = (
  sql: PointsSql,
  moduleId: string,
  roundIds?: readonly string[],
): PointRefundRequest[] => {
  const rounds = roundIds === undefined
    ? sql.exec<{ round_id: string }>(
      `SELECT round_id FROM game_rounds WHERE module_id = ? AND state IN ('announcing', 'open', 'resolving') ORDER BY created_at, round_id`,
      moduleId,
    ).toArray().map(({ round_id }) => round_id)
    : [...roundIds];
  return rounds.flatMap((roundId) => participantsForRoundSync(sql, roundId).map((participant) => {
    const operationId = `round:${roundId}:refund:${participant.accountId}`;
    const movements = [
      { accountId: participant.accountId, delta: participant.stake, login: participant.login },
      { accountId: `__escrow:${roundId}`, delta: -participant.stake },
    ] satisfies PointsMovement[];
    const result = { roundId, accountId: participant.accountId, amount: participant.stake };
    return { moduleId, operationId, movements, result, roundId };
  }));
};

export const joinPointRoundSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  operationId: string,
  accountId: string,
  login: string,
  stake: number,
  data: unknown,
  requestHash: string,
  nowMs: number,
  now: string,
): PointJoinResult => {
  assertPointRoundId(roundId);
  assertPointAccountId(accountId);
  const existingOperation = operationSync(sql, operationId);
  if (existingOperation !== null) {
    if (existingOperation.payload_hash !== requestHash) throw new Error("operation_conflict");
    const participant = sql.exec<{ account_id: string }>(
      "SELECT account_id FROM game_round_participants WHERE round_id = ? AND account_id = ?",
      roundId,
      accountId,
    ).toArray()[0];
    return participant === undefined ? { status: "round_closed" } : { status: "joined", replayed: true };
  }
  checkModuleGateSync(sql, moduleId);
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.module_id !== moduleId || round.state !== "open" || round.deadline_at === null || round.deadline_at <= nowMs) {
    return { status: "round_closed" };
  }
  if (pointKindFor(accountId) !== "viewer" || !Number.isSafeInteger(stake) || stake < 1 || login.length === 0) throw new Error("invalid_stake");
  const duplicate = sql.exec<{ account_id: string }>(
    "SELECT account_id FROM game_round_participants WHERE round_id = ? AND account_id = ?",
    roundId,
    accountId,
  ).toArray()[0];
  if (duplicate !== undefined) return { status: "already_joined" };
  applyPointOperationSync(sql, moduleId, operationId, "stake", [
    { accountId, delta: -stake, login },
    { accountId: `__escrow:${roundId}`, delta: stake },
  ], { roundId, accountId, stake }, requestHash, now);
  sql.exec(
    `INSERT INTO game_round_participants (round_id, account_id, login, stake, data_json)
     VALUES (?, ?, ?, ?, ?)`,
    roundId,
    accountId,
    login,
    stake,
    jsonValue(data),
  );
  return { status: "joined", replayed: false };
};

const potsForModuleSync = (sql: PointsSql, moduleId: string, roundId: string): Record<string, number> => {
  const rows = sql.exec<{ account_id: string; balance: number }>(
    `SELECT account_id, balance FROM point_accounts
      WHERE account_id = ? OR account_id = ? OR account_id = ?`,
    `__jackpot:${moduleId}`,
    `__escrow:${roundId}`,
    `__bosspot:${roundId}`,
  ).toArray();
  return Object.fromEntries(rows.map(({ account_id, balance }) => [account_id, balance]));
};

export const resolvePointRoundSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  settlement: { kind: string; params: unknown },
  settlements: ReadonlyMap<string, PointSettlement>,
  requestHash: string,
  now: string,
): PointApplyInternalResult => {
  assertPointRoundId(roundId);
  const operationId = `round:${roundId}:resolve`;
  const previous = operationSync(sql, operationId);
  if (previous !== null) {
    if (previous.payload_hash !== requestHash) throw new Error("operation_conflict");
    return {
      replayed: true,
      result: JSON.parse(previous.result_json) as unknown,
      balances: recordedBalancesSync(sql, operationId),
      deltas: Object.fromEntries(sql.exec<{ account_id: string; delta: number }>(
        "SELECT account_id, delta FROM point_ledger WHERE operation_id = ?", operationId,
      ).toArray().map(({ account_id, delta }) => [account_id, delta])),
    };
  }
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.module_id !== moduleId || round.state !== "open") throw new Error("round_closed");
  const cancellation = sql.exec<{ revision: number }>(
    "SELECT revision FROM game_round_cancellations WHERE module_id = ?",
    moduleId,
  ).toArray()[0];
  if (cancellation !== undefined) throw new Error("round_cancellation_pending");
  const handler = settlements.get(settlement.kind);
  if (handler === undefined) throw new Error("settlement_unknown");
  const participants = participantsForRoundSync(sql, roundId);
  const roundData = JSON.parse(round.data_json) as unknown;
  sql.exec("UPDATE game_rounds SET state = 'resolving' WHERE round_id = ? AND state = 'open'", roundId);
  let before: Map<string, number>;
  let applied: PointApplyInternalResult;
  try {
    const settled: PointSettlementOutput = handler({
      round: { roundId, moduleId, data: roundData },
      participants,
      pots: potsForModuleSync(sql, moduleId, roundId),
      params: settlement.params,
    });
    before = new Map(participants.map(({ accountId }) => [accountId, pointBalance(sql, accountId)]));
    applied = applyPointOperationSync(
      sql,
      moduleId,
      operationId,
      "resolve",
      settled.movements,
      settled.result,
      requestHash,
      now,
    );
  } catch {
    throw new Error("settlement_execution_failed");
  }
  if (!applied.replayed) {
    const month = now.slice(0, 7);
    for (const participant of participants) {
      const balanceBefore = before.get(participant.accountId) ?? 0;
      const balanceAfter = pointBalance(sql, participant.accountId);
      incrementMonthlySync(sql, participant.accountId, month, balanceAfter - balanceBefore - participant.stake, now);
    }
  }
  sql.exec("UPDATE game_rounds SET state = 'resolved' WHERE round_id = ? AND module_id = ?", roundId, moduleId);
  return applied;
};

export const cancelPointRoundsSync = (
  sql: PointsSql,
  moduleId: string,
  now: string,
  hashFor: (value: unknown) => string,
  roundIds?: readonly string[],
  expectedGateRevision?: number,
): number => {
  if (expectedGateRevision !== undefined) {
    const gate = sql.exec<{ revision: number; closed: number }>(
      "SELECT revision, closed FROM module_gates WHERE module_id = ?",
      moduleId,
    ).toArray()[0];
    const cancellation = sql.exec<{ revision: number }>(
      "SELECT revision FROM game_round_cancellations WHERE module_id = ?",
      moduleId,
    ).toArray()[0];
    const matchingPendingCancellation = gate?.closed === 1 && gate.revision === expectedGateRevision &&
      cancellation?.revision === expectedGateRevision;
    const delayedOlderCancellation = gate !== undefined && gate.revision > expectedGateRevision;
    if (!matchingPendingCancellation && !delayedOlderCancellation) return 0;
  }
  const rounds = roundIds === undefined
    ? sql.exec<{ round_id: string }>(
      `SELECT round_id FROM game_rounds WHERE module_id = ? AND state IN ('announcing', 'open', 'resolving') ORDER BY created_at, round_id`,
      moduleId,
    ).toArray().map(({ round_id }) => round_id)
    : [...roundIds];
  let cancelledCount = 0;
  let refundedStake = false;
  for (const roundId of rounds) {
    const round = pointRoundRow(sql, roundId);
    if (round === null || round.module_id !== moduleId ||
        (round.state !== "announcing" && round.state !== "open" && round.state !== "resolving")) continue;
    if (expectedGateRevision !== undefined && round.gate_revision >= expectedGateRevision) continue;
    const refunds = pointRoundRefundRequests(sql, moduleId, [roundId]);
    for (const refund of refunds) {
      const payload = { moduleId, operationId: refund.operationId, kind: "refund", movements: refund.movements, result: refund.result };
      applyPointOperationSync(sql, moduleId, refund.operationId, "refund", refund.movements,
        refund.result, hashFor(payload), now);
    }
    refundedStake ||= refunds.length > 0;
    sql.exec("UPDATE game_rounds SET state = 'cancelled' WHERE round_id = ? AND module_id = ?", roundId, moduleId);
    cancelledCount += 1;
  }
  if (expectedGateRevision !== undefined) {
    if (refundedStake) {
      sql.exec(
        `INSERT INTO game_round_cancellation_notices (module_id, revision, created_at)
         VALUES (?, ?, ?) ON CONFLICT(module_id, revision) DO NOTHING`,
        moduleId,
        expectedGateRevision,
        now,
      );
    }
    sql.exec(
      "DELETE FROM game_round_cancellations WHERE module_id = ? AND revision = ?",
      moduleId,
      expectedGateRevision,
    );
  }
  invariantSync(sql);
  return cancelledCount;
};

export const announceAttemptSync = (sql: PointsSql, roundId: string, now: number): {
  round: RoundRow | null;
  attempt: number | null;
  outcome: "attempt" | "ambiguous" | "pending" | "ignored";
} => {
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.state !== "announcing") return { round, attempt: null, outcome: "ignored" };
  if (round.announce_state === "pending" && round.announce_attempts > 0 && round.last_attempt_at !== null) {
    return {
      round,
      attempt: null,
      outcome: now - round.last_attempt_at >= POINTS_ANNOUNCE_AMBIGUOUS_MS ? "ambiguous" : "pending",
    };
  }
  if (round.announce_attempts >= POINTS_ANNOUNCE_MAX_ATTEMPTS) return { round, attempt: null, outcome: "ignored" };
  const attempt = round.announce_attempts + 1;
  sql.exec(
    `UPDATE game_rounds SET announce_state = 'pending', announce_attempts = ?, last_attempt_at = ?
      WHERE round_id = ? AND state = 'announcing'`,
    attempt,
    now,
    roundId,
  );
  return { round: { ...round, announce_state: "pending", announce_attempts: attempt, last_attempt_at: now }, attempt, outcome: "attempt" };
};

export const recordPointAnnouncementSync = (
  sql: PointsSql,
  roundId: string,
  state: "rate_limited" | "failed" | "delivered" | "ambiguous",
  deliveredAt: number,
): { moduleId: string; deadlineAt: number | null; alarmKey: string | null; cancelled: boolean } | null => {
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.state !== "announcing") return null;
  if (state === "rate_limited" && round.announce_attempts < POINTS_ANNOUNCE_MAX_ATTEMPTS) {
    sql.exec("UPDATE game_rounds SET announce_state = 'rate_limited' WHERE round_id = ?", roundId);
    return { moduleId: round.module_id, deadlineAt: null, alarmKey: round.alarm_key, cancelled: false };
  }
  if (state === "failed" || state === "rate_limited") {
    sql.exec("UPDATE game_rounds SET announce_state = 'failed' WHERE round_id = ?", roundId);
    return { moduleId: round.module_id, deadlineAt: null, alarmKey: round.alarm_key, cancelled: true };
  }
  const effectiveAt = deliveredAt;
  const deadlineAt = effectiveAt + round.duration_s * 1_000;
  const alarmKey = pointRoundAlarmKey(roundId);
  sql.exec(
    `UPDATE game_rounds SET announce_state = ?, state = 'open', deadline_at = ?, alarm_key = ?
      WHERE round_id = ?`,
    state,
    deadlineAt,
    alarmKey,
    roundId,
  );
  return { moduleId: round.module_id, deadlineAt, alarmKey, cancelled: false };
};

export const recoverablePointRounds = (sql: PointsSql): RoundRow[] =>
  sql.exec<RoundRow>(
    `SELECT round_id, module_id, gate_revision, state, deadline_at, alarm_key, data_json, created_at, duration_s,
            announce_text, announce_state, announce_attempts, last_attempt_at
       FROM game_rounds WHERE state IN ('announcing', 'open') ORDER BY created_at, round_id`,
  ).toArray();

export const settlementFromRoundData = (value: unknown): { kind: string; params: unknown } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const settlement = (value as PointRoundOpenData).settlement;
  return settlement === undefined ? null : settlement;
};
