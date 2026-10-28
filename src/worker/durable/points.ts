import type {
  ModulePointsAccess,
  PointJoinResult,
  PointRoundAnswerResult,
  PointRoundAttackResult,
  PointRoundChoiceResult,
  PointsApplyResult,
  PointsMovement,
  PointsKind,
  ModuleLanguage,
  PointWelcomeKind,
} from "../../modules/contract";
import { POINT_WELCOME_RESULT_ACCOUNT_ID_KEY } from "../point-welcome";
import { bossHealth } from "../../modules/boss_fight/domain/boss";
import { pointsCatalog } from "../../modules/points/locale";
import { POINT_SETTLEMENTS } from "./point-settlements";

export const POINTS_ROUND_ALARM_HANDLER = "host:points_round";
export const POINTS_ROUND_ALARM_PREFIX = "points:round:";
export const POINTS_CANCELLATION_NOTICE_ALARM_HANDLER = "host:points_cancellation_notice";
export const POINTS_CANCELLATION_NOTICE_ALARM_PREFIX = "points:cancellation_notice:";
export const POINTS_ANNOUNCE_RETRY_MS = 5_000;
export const POINTS_ANNOUNCE_MAX_ATTEMPTS = 6;
export const POINTS_ANNOUNCE_AMBIGUOUS_MS = 30_000;
const POINT_WELCOME_CLAIM_LEASE_MS = 2 * 60_000;

type PointRoundDeliveryStatus = "rate_limited" | "failed" | "delivered" | "ambiguous";
type PointRoundDeliveryDisposition = "retry" | "park" | "complete";

/** Shared start/result line policy: retry rate limits within the attempt cap, park definite failures, and complete ambiguity. */
const pointRoundDeliveryDisposition = (
  status: PointRoundDeliveryStatus,
  attempts: number,
): PointRoundDeliveryDisposition => {
  if (status === "rate_limited") return attempts < POINTS_ANNOUNCE_MAX_ATTEMPTS ? "retry" : "park";
  return status === "failed" ? "park" : "complete";
};

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
  announcement_at: string | null;
  alarm_key: string | null;
  data_json: string;
  created_at: string;
  duration_s: number;
  announce_text: string;
  announce_state: string;
  announce_attempts: number;
  last_attempt_at: number | null;
  prepare_state: "pending" | "delivered";
  resolve_delivery_state: "pending" | "sending" | "delivered" | "suppressed" | "failed";
  resolve_delivery_attempts: number;
  resolve_delivery_last_attempt_at: number | null;
  resolved_at: string | null;
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
  silentAnnouncement?: boolean;
  settlement?: { kind: string; params: unknown };
  resolveOperationId?: string;
  lockKeys?: string[];
  /** A pause that starts in the same transaction as the settlement, under the module's cooldown `key`. */
  cooldownAfter?: { key: string; seconds: number };
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

interface InstantPointSettlementInput {
  actor: { accountId: string; login: string };
  balance: number;
  stake: number;
  pots: Readonly<Record<string, number>>;
  params: unknown;
}

interface PointSettlementOutput {
  movements: PointsMovement[];
  result: unknown;
  clearParticipantData?: boolean;
}

export type PointSettlement = (input: PointSettlementInput) => PointSettlementOutput;
export type InstantPointSettlement = (input: InstantPointSettlementInput) => PointSettlementOutput;

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

const allowedKinds = new Set<PointsKind>(["bonus", "activity", "safety_net", "stake", "game", "resolve", "refund", "admin"]);
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

export interface CanonicalPointResult {
  json: string;
  value: unknown;
}

export const canonicalPointResult = (value: unknown): CanonicalPointResult => {
  if (value === undefined) return { json: "null", value: null };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("result_not_json_compatible");
  }
  if (typeof serialized !== "string") throw new Error("result_not_json_compatible");
  try {
    return { json: serialized, value: JSON.parse(serialized) as unknown };
  } catch {
    throw new Error("result_not_json_compatible");
  }
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
  sql.exec(`CREATE TABLE IF NOT EXISTS point_welcome_notes (
    account_id TEXT NOT NULL REFERENCES point_accounts(account_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    note_kind TEXT NOT NULL DEFAULT 'start_bonus',
    claim_id TEXT,
    claimed_at INTEGER,
    PRIMARY KEY (account_id, operation_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS point_welcome_deliveries (
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_id)
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
    announcement_at TEXT,
    alarm_key TEXT,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    duration_s INTEGER NOT NULL,
    announce_text TEXT NOT NULL,
    announce_state TEXT NOT NULL,
    announce_attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    prepare_state TEXT NOT NULL DEFAULT 'delivered',
    resolve_delivery_state TEXT NOT NULL DEFAULT 'delivered',
    resolve_delivery_attempts INTEGER NOT NULL DEFAULT 0,
    resolve_delivery_last_attempt_at INTEGER,
    announce_welcome_appended INTEGER NOT NULL DEFAULT 0,
    announce_welcome_claim_id TEXT,
    announce_welcome_operation_id TEXT,
    resolve_welcome_appended INTEGER NOT NULL DEFAULT 0,
    resolve_welcome_claim_id TEXT,
    resolve_welcome_operation_id TEXT,
    resolved_at TEXT
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS game_round_participants (
    round_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    login TEXT NOT NULL,
    stake INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (round_id, account_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS game_round_locks (
    module_id TEXT NOT NULL,
    lock_key TEXT NOT NULL,
    round_id TEXT NOT NULL,
    PRIMARY KEY (module_id, lock_key)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS game_round_answers (
    operation_id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    login TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('recorded', 'already_answered', 'round_closed')),
    first_answer INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS game_round_attacks (
    operation_id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
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
    revision INTEGER NOT NULL,
    last_disabled_revision INTEGER NOT NULL DEFAULT 0
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
  let pointWelcomeColumns = sql.exec<{ name: string; pk: number }>("PRAGMA table_info(point_welcome_notes)").toArray();
  if (!pointWelcomeColumns.some(({ name }) => name === "note_kind")) {
    sql.exec("ALTER TABLE point_welcome_notes ADD COLUMN note_kind TEXT NOT NULL DEFAULT 'start_bonus'");
  }
  if (!pointWelcomeColumns.some(({ name }) => name === "claimed_at")) {
    sql.exec("ALTER TABLE point_welcome_notes ADD COLUMN claimed_at INTEGER");
  }
  pointWelcomeColumns = sql.exec<{ name: string; pk: number }>("PRAGMA table_info(point_welcome_notes)").toArray();
  const hasLegacyPointWelcomeNotes = sql.exec<{ present: number }>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'point_welcome_notes_legacy') AS present",
  ).one().present === 1;
  const pointWelcomeNotesUseOperationKey = pointWelcomeColumns.some(({ name }) => name === "operation_id") &&
    pointWelcomeColumns.find(({ name }) => name === "account_id")?.pk === 1 &&
    pointWelcomeColumns.find(({ name }) => name === "operation_id")?.pk === 2;
  if (!pointWelcomeNotesUseOperationKey && !hasLegacyPointWelcomeNotes) {
    sql.exec("ALTER TABLE point_welcome_notes RENAME TO point_welcome_notes_legacy");
    sql.exec(`CREATE TABLE point_welcome_notes (
      account_id TEXT NOT NULL REFERENCES point_accounts(account_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      note_kind TEXT NOT NULL DEFAULT 'start_bonus',
      claim_id TEXT,
      claimed_at INTEGER,
      PRIMARY KEY (account_id, operation_id)
    )`);
  }
  if (hasLegacyPointWelcomeNotes || !pointWelcomeNotesUseOperationKey) {
    sql.exec(`INSERT OR IGNORE INTO point_welcome_notes
      (account_id, operation_id, message_id, text, note_kind, claim_id, claimed_at)
      SELECT legacy.account_id,
             CASE WHEN legacy.note_kind = 'safety_net' THEN COALESCE(
               (SELECT operation.operation_id
                  FROM point_operations AS operation
                  JOIN point_ledger AS ledger ON ledger.operation_id = operation.operation_id
                 WHERE operation.kind = 'safety_net' AND ledger.account_id = legacy.account_id
                 ORDER BY operation.created_at DESC LIMIT 1),
               'safety-net:' || legacy.account_id || ':legacy'
             ) ELSE 'bonus:' || legacy.account_id END,
             legacy.message_id, legacy.text, legacy.note_kind, legacy.claim_id, legacy.claimed_at
        FROM point_welcome_notes_legacy AS legacy`);
    sql.exec("DROP TABLE IF EXISTS point_welcome_notes_legacy");
  }
  sql.exec(`INSERT OR IGNORE INTO point_welcome_deliveries (account_id, operation_id, acknowledged_at)
    SELECT ledger.account_id, operation.operation_id, operation.created_at
      FROM point_operations AS operation
      JOIN point_ledger AS ledger ON ledger.operation_id = operation.operation_id
      LEFT JOIN point_accounts AS account ON account.account_id = ledger.account_id
     WHERE operation.kind IN ('bonus', 'safety_net')
       AND ledger.account_id <> '__house'
       AND NOT EXISTS (
         SELECT 1 FROM point_welcome_notes AS note
          WHERE note.account_id = ledger.account_id AND note.operation_id = operation.operation_id
       )
       AND (operation.kind = 'safety_net' OR account.welcome_pending = 0 OR EXISTS (
         SELECT 1 FROM point_welcome_notes AS note
          WHERE note.account_id = ledger.account_id AND note.note_kind = 'safety_net'
       ))`);
  sql.exec(`INSERT OR IGNORE INTO point_welcome_deliveries (account_id, operation_id, acknowledged_at)
    SELECT account.account_id, operation.operation_id, operation.created_at
      FROM point_operations AS operation
      JOIN point_accounts AS account ON operation.operation_id = 'bonus:' || account.account_id
     WHERE operation.kind = 'bonus'
       AND account.kind = 'viewer'
       AND NOT EXISTS (
         SELECT 1 FROM point_ledger AS ledger WHERE ledger.operation_id = operation.operation_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM point_welcome_notes AS note
          WHERE note.account_id = account.account_id AND note.operation_id = operation.operation_id
       )
       AND (account.welcome_pending = 0 OR EXISTS (
         SELECT 1 FROM point_welcome_notes AS note
          WHERE note.account_id = account.account_id AND note.note_kind = 'safety_net'
       ))`);
  if (!gameRoundColumns.some(({ name }) => name === "prepare_state")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN prepare_state TEXT NOT NULL DEFAULT 'delivered'");
  }
  if (!gameRoundColumns.some(({ name }) => name === "announcement_at")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN announcement_at TEXT");
  }
  if (!gameRoundColumns.some(({ name }) => name === "resolve_delivery_state")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN resolve_delivery_state TEXT NOT NULL DEFAULT 'delivered'");
  }
  if (!gameRoundColumns.some(({ name }) => name === "resolve_delivery_attempts")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN resolve_delivery_attempts INTEGER NOT NULL DEFAULT 0");
  }
  if (!gameRoundColumns.some(({ name }) => name === "resolve_delivery_last_attempt_at")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN resolve_delivery_last_attempt_at INTEGER");
  }
  if (!gameRoundColumns.some(({ name }) => name === "resolved_at")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN resolved_at TEXT");
  }
  if (!gameRoundColumns.some(({ name }) => name === "announce_welcome_appended")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN announce_welcome_appended INTEGER NOT NULL DEFAULT 0");
  }
  if (!gameRoundColumns.some(({ name }) => name === "announce_welcome_claim_id")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN announce_welcome_claim_id TEXT");
  }
  if (!gameRoundColumns.some(({ name }) => name === "announce_welcome_operation_id")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN announce_welcome_operation_id TEXT");
  }
  if (!gameRoundColumns.some(({ name }) => name === "resolve_welcome_appended")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN resolve_welcome_appended INTEGER NOT NULL DEFAULT 0");
  }
  if (!gameRoundColumns.some(({ name }) => name === "resolve_welcome_claim_id")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN resolve_welcome_claim_id TEXT");
  }
  if (!gameRoundColumns.some(({ name }) => name === "resolve_welcome_operation_id")) {
    sql.exec("ALTER TABLE game_rounds ADD COLUMN resolve_welcome_operation_id TEXT");
  }
  sql.exec(`UPDATE game_rounds
               SET announce_welcome_operation_id = (
                 SELECT note.operation_id FROM point_welcome_notes AS note
                  WHERE note.claim_id = game_rounds.announce_welcome_claim_id LIMIT 1
               )
             WHERE announce_welcome_operation_id IS NULL AND announce_welcome_claim_id IS NOT NULL`);
  sql.exec(`UPDATE game_rounds
               SET resolve_welcome_operation_id = (
                 SELECT note.operation_id FROM point_welcome_notes AS note
                  WHERE note.claim_id = game_rounds.resolve_welcome_claim_id LIMIT 1
               )
             WHERE resolve_welcome_operation_id IS NULL AND resolve_welcome_claim_id IS NOT NULL`);
  const moduleGateColumns = sql.exec<{ name: string }>("PRAGMA table_info(module_gates)").toArray();
  if (!moduleGateColumns.some(({ name }) => name === "last_disabled_revision")) {
    sql.exec("ALTER TABLE module_gates ADD COLUMN last_disabled_revision INTEGER NOT NULL DEFAULT 0");
  }
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
  sql.exec("CREATE INDEX IF NOT EXISTS game_rounds_module_resolution ON game_rounds (module_id, state, resolved_at DESC, round_id DESC)");
};

const ensureAccountSync = (sql: PointsSql, accountId: string, login: string | null, now: string): AccountRow => {
  assertLedgerAccountId(accountId);
  const kind = pointKindFor(accountId);
  sql.exec(
    `INSERT INTO point_accounts (account_id, kind, login, balance, welcome_pending, updated_at)
     VALUES (?, ?, ?, 0, 0, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       login = excluded.login,
       updated_at = excluded.updated_at
     WHERE excluded.login IS NOT NULL AND point_accounts.login IS NOT excluded.login`,
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
  if (!Number.isSafeInteger(net)) throw new Error("monthly_overflow");
  const existing = sql.exec<{ net_won: string }>(
    "SELECT CAST(net_won AS TEXT) AS net_won FROM point_monthly WHERE account_id = ? AND month = ?",
    accountId,
    month,
  ).toArray()[0];
  const next = BigInt(existing?.net_won ?? "0") + BigInt(net);
  if (next < BigInt(Number.MIN_SAFE_INTEGER) || next > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("monthly_overflow");
  }
  sql.exec(
    `INSERT INTO point_monthly (account_id, month, net_won, reached_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, month) DO UPDATE SET
       net_won = excluded.net_won,
       reached_at = CASE WHEN ? = 0 THEN point_monthly.reached_at ELSE excluded.reached_at END`,
    accountId,
    month,
    Number(next),
    at,
    net,
  );
};

const expandedMovementsSync = (
  sql: PointsSql,
  movements: readonly PointsMovement[],
  now: string,
): Map<string, number> => {
  const deltaTotals = new Map<string, bigint>();
  const running = new Map<string, number>();
  const safeInteger = (value: bigint, errorCode: string): number => {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(errorCode);
    }
    return Number(value);
  };
  const currentBalance = (accountId: string): number => {
    const cached = running.get(accountId);
    if (cached !== undefined) return cached;
    const row = ensureAccountSync(sql, accountId, null, now);
    running.set(accountId, row.balance);
    return row.balance;
  };
  const addSegment = (segment: Map<string, { delta: bigint; login: string | null }>): void => {
    for (const [accountId, movement] of segment) {
      if (movement.delta === 0n) continue;
      const next = safeInteger(BigInt(currentBalance(accountId)) + movement.delta, "balance_overflow");
      running.set(accountId, next);
      deltaTotals.set(accountId, (deltaTotals.get(accountId) ?? 0n) + movement.delta);
      if (movement.login !== null) ensureAccountSync(sql, accountId, movement.login, now);
    }
  };
  let segment = new Map<string, { delta: bigint; login: string | null }>();
  for (const movement of movements) {
    if ("delta" in movement) {
      if (!Number.isSafeInteger(movement.delta)) throw new Error("invalid_movement");
      const existing = segment.get(movement.accountId);
      segment.set(movement.accountId, {
        delta: (existing?.delta ?? 0n) + BigInt(movement.delta),
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
      const nextViewerBalance = safeInteger(BigInt(viewerBalance) + BigInt(share), "balance_overflow");
      running.set(pot, safeInteger(BigInt(currentBalance(pot)) - BigInt(share), "balance_overflow"));
      running.set(movement.accountId, nextViewerBalance);
      deltaTotals.set(pot, (deltaTotals.get(pot) ?? 0n) - BigInt(share));
      deltaTotals.set(movement.accountId, (deltaTotals.get(movement.accountId) ?? 0n) + BigInt(share));
    }
  }
  addSegment(segment);
  const deltas = new Map<string, number>();
  for (const [accountId, delta] of deltaTotals) {
    deltas.set(accountId, safeInteger(delta, "invalid_movement"));
  }
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
  canonicalResult?: CanonicalPointResult,
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

  const gameAccounts = new Map<string, string | null>();
  if (kind === "game") {
    for (const movement of movements) {
      if (!movement.accountId.startsWith("__")) {
        const previousLogin = gameAccounts.get(movement.accountId);
        const login = "delta" in movement ? movement.login : undefined;
        gameAccounts.set(movement.accountId, login ?? previousLogin ?? null);
      }
    }
  }
  const deltas = expandedMovementsSync(sql, movements, now);
  for (const [accountId, delta] of deltas) {
    if (!Number.isSafeInteger(delta)) throw new Error("invalid_movement");
    ensureAccountSync(sql, accountId, null, now);
  }
  const total = [...deltas.values()].reduce((sum, delta) => sum + BigInt(delta), 0n);
  if (total !== 0n) throw new Error("ledger_not_zero_sum");

  const finalBalances = new Map<string, number>();
  for (const [accountId, delta] of deltas) {
    const account = sql.exec<AccountRow>(
      "SELECT account_id, kind, login, balance, welcome_pending FROM point_accounts WHERE account_id = ?",
      accountId,
    ).one();
    const balanceBigInt = BigInt(account.balance) + BigInt(delta);
    if (balanceBigInt < BigInt(Number.MIN_SAFE_INTEGER) || balanceBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("balance_overflow");
    }
    const balance = Number(balanceBigInt);
    if (accountId !== "__house" && balance < 0) throw new Error("insufficient_balance");
    finalBalances.set(accountId, balance);
  }

  const persistedResult = canonicalResult ?? canonicalPointResult(result);
  sql.exec(
    `INSERT INTO point_operations (operation_id, module_id, kind, result_json, payload_hash, audit_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    operationId,
    moduleId,
    kind,
    persistedResult.json,
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
    for (const [accountId, login] of gameAccounts) ensureAccountSync(sql, accountId, login, now);
    const month = now.slice(0, 7);
    for (const accountId of gameAccounts.keys()) incrementMonthlySync(sql, accountId, month, deltas.get(accountId) ?? 0, now);
  }
  invariantSync(sql);
  return {
    replayed: false,
    result: persistedResult.value,
    balances: Object.fromEntries(finalBalances),
    deltas: Object.fromEntries(deltas),
  };
};

/** Checks replay, gate, gross stake and cooldown before calculating a state-dependent instant settlement. */
export const settlePointOperationSync = (
  sql: PointsSql,
  moduleId: string,
  operationId: string,
  actor: { accountId: string; login: string },
  stake: number,
  params: unknown,
  handler: InstantPointSettlement | undefined,
  payloadHash: string,
  now: string,
  cooldown?: { key: string; seconds: number },
): PointApplyInternalResult => {
  if (operationId.length === 0 || operationId.length > 200) throw new Error("invalid_operation_id");
  const previous = operationSync(sql, operationId);
  if (previous !== null) {
    if (previous.payload_hash !== payloadHash) throw new Error("operation_conflict");
    return {
      replayed: true,
      result: JSON.parse(previous.result_json) as unknown,
      balances: recordedBalancesSync(sql, operationId),
      deltas: Object.fromEntries(sql.exec<{ account_id: string; delta: number }>(
        "SELECT account_id, delta FROM point_ledger WHERE operation_id = ?", operationId,
      ).toArray().map(({ account_id, delta }) => [account_id, delta])),
    };
  }
  checkModuleGateSync(sql, moduleId);
  assertPointAccountId(actor.accountId);
  if (!Number.isSafeInteger(stake) || stake < 1) throw new Error("invalid_stake");
  const balance = pointBalance(sql, actor.accountId);
  if (balance < stake) throw new Error("insufficient_balance");
  if (cooldown !== undefined && !claimPointCooldownSync(sql, moduleId, cooldown.key, cooldown.seconds, Date.parse(now))) {
    throw new Error("cooldown");
  }
  if (handler === undefined) throw new Error("settlement_unknown");
  const settled = handler({ actor, balance, stake, pots: jackpotForModuleSync(sql, moduleId), params });
  return applyPointOperationSync(
    sql,
    moduleId,
    operationId,
    "game",
    settled.movements,
    settled.result,
    payloadHash,
    now,
    canonicalPointResult(settled.result),
  );
};

export const touchPointAccountSync = (
  sql: PointsSql,
  moduleId: string,
  accountId: string,
  login: string,
  startBonus: number,
  bonusHash: string,
  now: string,
): { accountExisted: boolean; welcomePending: boolean; startBonus: number | null } => {
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
    return { accountExisted: false, welcomePending: true, startBonus };
  }
  if (existing.kind !== "viewer") throw new Error("account_kind_conflict");
  if (existing.login !== login) {
    sql.exec("UPDATE point_accounts SET login = ?, updated_at = ? WHERE account_id = ?", login, now, accountId);
  }
  const bonus = operationSync(sql, `bonus:${accountId}`);
  let bookedStartBonus: number | null = null;
  if (bonus !== null) {
    try {
      const result: unknown = JSON.parse(bonus.result_json);
      if (typeof result === "object" && result !== null && !Array.isArray(result)) {
        const amount: unknown = Reflect.get(result, "amount");
        if (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0) bookedStartBonus = amount;
      }
    } catch {
      // A missing or malformed legacy result cannot provide a reliable welcome amount.
    }
  }
  return { accountExisted: true, welcomePending: existing.welcome_pending === 1, startBonus: bookedStartBonus };
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
  const day = pointActivityDayKey(messageAt);
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

export const pointActivityDayKey = (messageAt: number): string => new Date(messageAt).toISOString().slice(0, 10);

export const creditPointSafetyNetSync = (
  sql: PointsSql,
  moduleId: string,
  accountId: string,
  login: string,
  messageAt: number,
  live: boolean,
  rules: { amount: number; threshold: number },
  payloadHash: string,
  welcome: { messageId: string; text: string },
  now: string,
): { credited: number } => {
  if (!Number.isFinite(messageAt) || !Number.isSafeInteger(rules.amount) || rules.amount < 1 ||
      !Number.isSafeInteger(rules.threshold) || rules.threshold < 1 || pointKindFor(accountId) !== "viewer" ||
      login.length === 0 || welcome.messageId.length === 0 || welcome.messageId.length > 256 || welcome.text.length === 0) {
    throw new Error("invalid_safety_net_rules");
  }
  if (!live) return { credited: 0 };

  const operationId = `safety-net:${accountId}:${pointActivityDayKey(messageAt)}`;
  const previousOperation = operationSync(sql, operationId);
  if (previousOperation !== null) {
    if (previousOperation.module_id !== moduleId || previousOperation.kind !== "safety_net") throw new Error("operation_conflict");
    return { credited: 0 };
  }

  const account = sql.exec<{ balance: number; welcome_pending: number }>(
    "SELECT balance, welcome_pending FROM point_accounts WHERE account_id = ? AND kind = 'viewer'",
    accountId,
  ).toArray()[0];
  if (account === undefined || account.balance >= rules.threshold) return { credited: 0 };
  if (account.welcome_pending === 1) {
    const hasStartBonus = sql.exec<{ pending: number }>(
      `SELECT 1 AS pending FROM point_welcome_notes
        WHERE account_id = ? AND note_kind = 'start_bonus'
       UNION ALL
       SELECT 1 AS pending WHERE NOT EXISTS (
         SELECT 1 FROM point_welcome_notes WHERE account_id = ?
       )
       LIMIT 1`,
      accountId,
      accountId,
    ).toArray().length > 0;
    // First-contact notes take priority. A note-less legacy pending bit may still be awaiting its start-bonus text.
    if (hasStartBonus) return { credited: 0 };
  }

  applyPointOperationSync(sql, moduleId, operationId, "safety_net", [
    { accountId, delta: rules.amount, login },
    { accountId: "__house", delta: -rules.amount },
  ], { amount: rules.amount, threshold: rules.threshold, messageAt: new Date(messageAt).toISOString() }, payloadHash, now);
  sql.exec("UPDATE point_accounts SET welcome_pending = 1, login = ?, updated_at = ? WHERE account_id = ?", login, now, accountId);
  storePendingPointWelcomeSync(sql, {
    accountId,
    operationId,
    messageId: welcome.messageId,
    text: welcome.text,
    kind: "safety_net",
  });
  invariantSync(sql);
  return { credited: rules.amount };
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
  const monthJoin = "LEFT JOIN point_monthly AS monthly ON monthly.account_id = account.account_id AND monthly.month = ?";
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
      monthNet: row.month_net,
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

export const pointAccount = (
  sql: PointsSql,
  accountId: string,
): Awaited<ReturnType<ModulePointsAccess["getAccount"]>> => {
  const row = sql.exec<{ account_id: string; login: string | null; balance: number }>(
    "SELECT account_id, login, balance FROM point_accounts WHERE account_id = ? AND kind = 'viewer' LIMIT 1",
    accountId,
  ).toArray()[0];
  return row === undefined ? null : { accountId: row.account_id, login: row.login ?? row.account_id, balance: row.balance };
};

export interface StoredPointWelcome {
  accountId: string;
  operationId: string;
  messageId: string;
  text: string;
  kind: PointWelcomeKind;
}

export const storePendingPointWelcomeSync = (sql: PointsSql, welcome: StoredPointWelcome): void => {
  assertPointAccountId(welcome.accountId);
  const kind: unknown = welcome.kind;
  if ((kind !== "start_bonus" && kind !== "safety_net") || welcome.operationId.length === 0 ||
      welcome.operationId.length > 200 ||
      (kind === "start_bonus" && welcome.operationId !== `bonus:${welcome.accountId}`) ||
      (kind === "safety_net" && !welcome.operationId.startsWith(`safety-net:${welcome.accountId}:`)) ||
      welcome.messageId.length === 0 || welcome.messageId.length > 256 || welcome.text.length === 0) return;
  const account = sql.exec<{ welcome_pending: number }>(
    "SELECT welcome_pending FROM point_accounts WHERE account_id = ? AND kind = 'viewer'",
    welcome.accountId,
  ).toArray()[0];
  if (account?.welcome_pending !== 1) return;
  const delivered = sql.exec<{ acknowledged_at: string }>(
    "SELECT acknowledged_at FROM point_welcome_deliveries WHERE account_id = ? AND operation_id = ?",
    welcome.accountId,
    welcome.operationId,
  ).toArray()[0];
  if (delivered !== undefined) return;
  sql.exec(
    `INSERT INTO point_welcome_notes (account_id, operation_id, message_id, text, note_kind)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, operation_id) DO UPDATE SET message_id = excluded.message_id
     WHERE point_welcome_notes.note_kind = excluded.note_kind AND point_welcome_notes.claim_id IS NULL`,
    welcome.accountId,
    welcome.operationId,
    welcome.messageId,
    welcome.text,
    welcome.kind,
  );
};

export const pendingPointWelcomeSync = (sql: PointsSql, accountId: string): StoredPointWelcome | null => {
  assertPointAccountId(accountId);
  const row = sql.exec<{ account_id: string; operation_id: string; message_id: string; text: string; note_kind: string }>(
    `SELECT note.account_id, note.operation_id, note.message_id, note.text, note.note_kind
       FROM point_accounts AS account
       JOIN point_welcome_notes AS note ON note.account_id = account.account_id
      WHERE account.account_id = ? AND account.kind = 'viewer' AND account.welcome_pending = 1
      ORDER BY CASE note.note_kind WHEN 'start_bonus' THEN 0 ELSE 1 END, note.operation_id`,
    accountId,
  ).toArray()[0];
  return row === undefined ? null : {
    accountId: row.account_id,
    operationId: row.operation_id,
    messageId: row.message_id,
    text: row.text,
    kind: row.note_kind === "safety_net" ? "safety_net" : "start_bonus",
  };
};

export const claimPendingPointWelcomeSync = (
  sql: PointsSql,
  accountId: string,
  operationId: string,
  claimId: string,
  now: number,
): StoredPointWelcome | null => {
  assertPointAccountId(accountId);
  if (operationId.length === 0 || operationId.length > 200 || claimId.length === 0 || claimId.length > 512) return null;
  sql.exec(
    `UPDATE point_welcome_notes SET claim_id = ?, claimed_at = ?
      WHERE account_id = ? AND operation_id = ? AND (
        claim_id IS NULL OR claim_id = ? OR claimed_at IS NULL OR claimed_at <= ?
      )
        AND EXISTS (
          SELECT 1 FROM point_accounts AS account
           WHERE account.account_id = point_welcome_notes.account_id AND account.welcome_pending = 1
        )`,
    claimId,
    now,
    accountId,
    operationId,
    claimId,
    now - POINT_WELCOME_CLAIM_LEASE_MS,
  );
  const row = sql.exec<{ account_id: string; operation_id: string; message_id: string; text: string; note_kind: string }>(
    `SELECT account_id, operation_id, message_id, text, note_kind FROM point_welcome_notes
      WHERE account_id = ? AND operation_id = ? AND claim_id = ?`,
    accountId,
    operationId,
    claimId,
  ).toArray()[0];
  return row === undefined ? null : {
    accountId: row.account_id,
    operationId: row.operation_id,
    messageId: row.message_id,
    text: row.text,
    kind: row.note_kind === "safety_net" ? "safety_net" : "start_bonus",
  };
};

export const releasePointWelcomeClaimSync = (
  sql: PointsSql,
  accountId: string,
  operationId: string,
  claimId: string,
): void => {
  assertPointAccountId(accountId);
  sql.exec(
    `UPDATE point_welcome_notes SET claim_id = NULL, claimed_at = NULL
      WHERE account_id = ? AND operation_id = ? AND claim_id = ?
        AND EXISTS (
          SELECT 1 FROM point_accounts AS account
           WHERE account.account_id = point_welcome_notes.account_id AND account.welcome_pending = 1
        )`,
    accountId,
    operationId,
    claimId,
  );
};

export const acknowledgeWelcomeSync = (
  sql: PointsSql,
  accountId: string,
  operationId: string,
  claimId: string,
  now: string,
): void => {
  assertPointAccountId(accountId);
  const note = sql.exec<{ operation_id: string }>(
    "SELECT operation_id FROM point_welcome_notes WHERE account_id = ? AND operation_id = ? AND claim_id = ?",
    accountId,
    operationId,
    claimId,
  ).toArray()[0];
  if (note === undefined) return;
  sql.exec(
    `INSERT OR IGNORE INTO point_welcome_deliveries (account_id, operation_id, acknowledged_at)
     VALUES (?, ?, ?)`,
    accountId,
    operationId,
    now,
  );
  sql.exec("DELETE FROM point_welcome_notes WHERE account_id = ? AND operation_id = ? AND claim_id = ?",
    accountId, operationId, claimId);
  sql.exec(
    `UPDATE point_accounts SET welcome_pending = CASE WHEN EXISTS (
       SELECT 1 FROM point_welcome_notes WHERE account_id = ?
     ) THEN 1 ELSE 0 END, updated_at = ?
      WHERE account_id = ?`,
    accountId,
    now,
    accountId,
  );
};

export interface PreparedPointChat {
  accountExisted: boolean;
  welcomePending: boolean;
  startBonus: number | null;
  pendingWelcome: StoredPointWelcome | null;
}

export const preparePointChatSync = (
  sql: PointsSql,
  moduleId: string,
  accountId: string,
  login: string,
  startBonus: number,
  bonusHash: string,
  messageAt: number,
  live: boolean,
  activityRules: { amount: number; windowMinutes: number; dailyCap: number },
  activityHash: string,
  safetyNetRules: { amount: number; threshold: number } | null,
  safetyNetHash: string | null,
  welcomes: { messageId: string; language: ModuleLanguage; currencyName: string; safetyNetText: string },
  now: string,
): PreparedPointChat => {
  const touched = touchPointAccountSync(sql, moduleId, accountId, login, startBonus, bonusHash, now);
  if (touched.welcomePending && touched.startBonus !== null) {
    storePendingPointWelcomeSync(sql, {
      accountId,
      operationId: `bonus:${accountId}`,
      messageId: welcomes.messageId,
      text: pointsCatalog[welcomes.language].chat.startBonus(touched.startBonus, welcomes.currencyName),
      kind: "start_bonus",
    });
  }
  if (touched.accountExisted && safetyNetRules !== null && safetyNetHash !== null) {
    creditPointSafetyNetSync(sql, moduleId, accountId, login, messageAt, live, safetyNetRules, safetyNetHash, {
      messageId: welcomes.messageId,
      text: welcomes.safetyNetText,
    }, now);
  }
  creditPointActivitySync(sql, moduleId, accountId, login, messageAt, live, activityRules, () => activityHash, now);
  const welcomePending = sql.exec<{ welcome_pending: number }>(
    "SELECT welcome_pending FROM point_accounts WHERE account_id = ? AND kind = 'viewer'",
    accountId,
  ).toArray()[0]?.welcome_pending === 1;
  if (welcomePending) {
    sql.exec(
      `UPDATE point_welcome_notes SET message_id = ? WHERE account_id = ? AND (
        claim_id IS NULL OR claimed_at IS NULL OR claimed_at <= ?
      )`,
      welcomes.messageId,
      accountId,
      Date.parse(now) - POINT_WELCOME_CLAIM_LEASE_MS,
    );
  }
  return {
    accountExisted: touched.accountExisted,
    welcomePending,
    startBonus: touched.startBonus,
    pendingWelcome: welcomePending ? pendingPointWelcomeSync(sql, accountId) : null,
  };
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
  lastDisabledRevision: number | null = null,
  onRoundCancelled?: (roundId: string) => void,
  onRoundSuppressed?: (roundId: string) => void,
  queueCancellationNotice = true,
): { applied: boolean } => {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_revision");
  if (lastDisabledRevision !== null && (!Number.isSafeInteger(lastDisabledRevision) || lastDisabledRevision < 1)) {
    throw new Error("invalid_revision");
  }
  if (!closed) {
    const cancellation = sql.exec<{ revision: number }>(
      "SELECT revision FROM game_round_cancellations WHERE module_id = ?",
      moduleId,
    ).toArray()[0];
    const cancellationRevision = Math.max(lastDisabledRevision ?? 0, cancellation?.revision ?? 0) || null;
    if (cancellationRevision !== null) {
      const currentGate = sql.exec<{ revision: number }>(
        "SELECT revision FROM module_gates WHERE module_id = ?",
        moduleId,
      ).toArray()[0];
      if (currentGate === undefined || currentGate.revision <= cancellationRevision) {
        sql.exec(
          `INSERT INTO module_gates (module_id, closed, revision, last_disabled_revision) VALUES (?, 1, ?, ?)
           ON CONFLICT(module_id) DO UPDATE SET closed = 1, revision = excluded.revision,
             last_disabled_revision = MAX(module_gates.last_disabled_revision, excluded.last_disabled_revision)`,
          moduleId,
          cancellationRevision,
          cancellationRevision,
        );
      }
      sql.exec(
        `INSERT INTO game_round_cancellations (module_id, revision) VALUES (?, ?)
         ON CONFLICT(module_id) DO UPDATE SET revision = excluded.revision`,
        moduleId,
        cancellationRevision,
      );
      const roundIds = sql.exec<{ round_id: string }>(
        `SELECT round_id FROM game_rounds
          WHERE module_id = ? AND gate_revision < ? AND state IN ('announcing', 'open', 'resolving')
          ORDER BY created_at, round_id`,
        moduleId,
        cancellationRevision,
      ).toArray().map(({ round_id }) => round_id);
      cancelPointRoundsSync(
        sql,
        moduleId,
        now,
        hashFor,
        roundIds,
        cancellationRevision,
        onRoundCancelled,
        queueCancellationNotice,
      );
    }
  }
  const existing = sql.exec<{ revision: number; closed: number; last_disabled_revision: number }>(
    "SELECT revision, closed, last_disabled_revision FROM module_gates WHERE module_id = ?",
    moduleId,
  ).toArray()[0];
  const disableRevision = closed
    ? revision
    : Math.max(lastDisabledRevision ?? 0, existing?.last_disabled_revision ?? 0) || null;
  if (disableRevision !== null) suppressPointRoundResultDeliveriesSync(sql, moduleId, disableRevision, onRoundSuppressed);
  if (existing !== undefined && revision <= existing.revision) {
    if (disableRevision !== null && disableRevision > existing.last_disabled_revision) {
      sql.exec("UPDATE module_gates SET last_disabled_revision = ? WHERE module_id = ?", disableRevision, moduleId);
    }
    return { applied: false };
  }
  const nextDisabledRevision = Math.max(existing?.last_disabled_revision ?? 0, closed ? revision : lastDisabledRevision ?? 0);
  sql.exec(
    `INSERT INTO module_gates (module_id, closed, revision, last_disabled_revision) VALUES (?, ?, ?, ?)
     ON CONFLICT(module_id) DO UPDATE SET closed = excluded.closed, revision = excluded.revision,
       last_disabled_revision = excluded.last_disabled_revision`,
    moduleId,
    closed ? 1 : 0,
    revision,
    nextDisabledRevision,
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

/** Reads a cooldown without initializing the points schema or modifying its deadline. */
export const pointCooldownRemainingSync = (sql: PointsSql, moduleId: string, key: string, now: number): number => {
  if (moduleId.length === 0 || key.length === 0 || !Number.isFinite(now)) throw new Error("invalid_cooldown");
  const schemaPresent = sql.exec<{ present: number }>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'game_cooldowns') AS present",
  ).one().present === 1;
  if (!schemaPresent) return 0;
  const fullKey = `${moduleId}:${key}`;
  const previous = sql.exec<{ until_at: string }>("SELECT until_at FROM game_cooldowns WHERE key = ?", fullKey).toArray()[0];
  if (previous === undefined) return 0;
  const deadline = Date.parse(previous.until_at);
  return Number.isFinite(deadline) && deadline > now ? Math.ceil((deadline - now) / 1_000) : 0;
};

const parseRoundOpenData = (value: unknown): {
  data: unknown;
  durationS: number;
  announceText: string;
  settlement: { kind: string; params: unknown };
  lockKeys?: string[];
} => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_round");
  const data = value as PointRoundOpenData;
  const durationS = data.durationS ?? data.duration_s;
  const announceText = data.announceText ?? data.announce_text;
  const silentAnnouncement = data.silentAnnouncement === true;
  if (!Number.isSafeInteger(durationS) || (durationS ?? 0) < 1 || (durationS ?? 0) > 86_400 || typeof announceText !== "string" ||
      (announceText.length === 0 && !silentAnnouncement)) {
    throw new Error("invalid_round");
  }
  const rawSettlement: unknown = (value as Record<string, unknown>).settlement;
  if (typeof rawSettlement !== "object" || rawSettlement === null || Array.isArray(rawSettlement) ||
      typeof (rawSettlement as { kind?: unknown }).kind !== "string" ||
      (rawSettlement as { kind: string }).kind.length === 0) {
    throw new Error("settlement_unknown");
  }
  if (data.resolveOperationId !== undefined && (typeof data.resolveOperationId !== "string" ||
      data.resolveOperationId.length === 0 || data.resolveOperationId.length > 200)) throw new Error("invalid_round_data");
  const after: unknown = data.cooldownAfter;
  if (after !== undefined) {
    const { key, seconds } = (typeof after === "object" && after !== null ? after : {}) as { key?: unknown; seconds?: unknown };
    if (typeof key !== "string" || key.length === 0 || !Number.isSafeInteger(seconds) || (seconds as number) < 0 ||
        (seconds as number) > 86_400) throw new Error("invalid_round_data");
  }
  let lockKeys: string[] | undefined;
  if (data.lockKeys !== undefined) {
    if (!Array.isArray(data.lockKeys) || data.lockKeys.length === 0 || data.lockKeys.length > 4 ||
        data.lockKeys.some((key) => typeof key !== "string" || !/^[a-z]+:[A-Za-z0-9_]{1,64}$/.test(key)) ||
        new Set(data.lockKeys).size !== data.lockKeys.length) throw new Error("invalid_round_data");
    lockKeys = data.lockKeys;
  }
  return {
    data,
    durationS: durationS as number,
    announceText,
    settlement: rawSettlement as { kind: string; params: unknown },
    ...(lockKeys === undefined ? {} : { lockKeys }),
  };
};

export const pointRoundAlarmKey = (roundId: string): string => `${POINTS_ROUND_ALARM_PREFIX}${roundId}`;

export const pointRoundResolveOperationId = (roundId: string, data: unknown): string => {
  const record = typeof data === "object" && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown> : null;
  const resolveOperationId = record?.resolveOperationId;
  return typeof resolveOperationId === "string" && resolveOperationId.length > 0 && resolveOperationId.length <= 200
    ? resolveOperationId
    : `round:${roundId}:resolve`;
};

export const pointRoundRow = (sql: PointsSql, roundId: string): RoundRow | null =>
  sql.exec<RoundRow>(
    `SELECT round_id, module_id, gate_revision, state, deadline_at, announcement_at, alarm_key, data_json, created_at, duration_s,
            announce_text, announce_state, announce_attempts, last_attempt_at,
            prepare_state, resolve_delivery_state, resolve_delivery_attempts, resolve_delivery_last_attempt_at, resolved_at
       FROM game_rounds WHERE round_id = ?`,
    roundId,
  ).toArray()[0] ?? null;

export const pointRoundParticipantsSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  nameLimit: number,
): { count: number; totalStake: number; logins: string[] } => {
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.module_id !== moduleId) return { count: 0, totalStake: 0, logins: [] };
  const totals = sql.exec<{ count: number; total: number }>(
    "SELECT COUNT(*) AS count, COALESCE(SUM(stake), 0) AS total FROM game_round_participants WHERE round_id = ?",
    roundId,
  ).one();
  const logins = sql.exec<{ login: string }>(
    "SELECT login FROM game_round_participants WHERE round_id = ? ORDER BY rowid LIMIT ?",
    roundId,
    Math.max(0, Math.min(Math.trunc(nameLimit), 50)),
  ).toArray().map(({ login }) => login);
  return { count: totals.count, totalStake: totals.total, logins };
};

export const pointRoundDeliveryGateIsCurrentSync =(sql: PointsSql, round: Pick<RoundRow, "module_id" | "gate_revision">): boolean => {
  const gate = sql.exec<{ closed: number; last_disabled_revision: number }>(
    "SELECT closed, last_disabled_revision FROM module_gates WHERE module_id = ?",
    round.module_id,
  ).toArray()[0];
  return gate === undefined || (gate.closed === 0 && round.gate_revision >= gate.last_disabled_revision);
};

const suppressPointRoundResultDeliveriesSync = (
  sql: PointsSql,
  moduleId: string,
  disableRevision: number,
  onRoundSuppressed?: (roundId: string) => void,
): string[] => {
  const roundIds = sql.exec<{ round_id: string }>(
    `SELECT round_id FROM game_rounds
      WHERE module_id = ? AND gate_revision < ? AND state = 'resolved'
        AND resolve_delivery_state IN ('pending', 'sending')
      ORDER BY created_at, round_id`,
    moduleId,
    disableRevision,
  ).toArray().map(({ round_id }) => round_id);
  for (const roundId of roundIds) {
    sql.exec(
      `UPDATE game_rounds SET resolve_delivery_state = 'suppressed'
        WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state IN ('pending', 'sending')`,
      roundId,
    );
    onRoundSuppressed?.(roundId);
  }
  return roundIds;
};

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
  if (parsed.lockKeys === undefined) {
    const active = sql.exec<{ round_id: string }>(
      `SELECT round_id FROM game_rounds
        WHERE module_id = ? AND state IN ('announcing', 'open')
        ORDER BY created_at, round_id LIMIT 1`,
      moduleId,
    ).toArray()[0];
    if (active !== undefined) throw new Error("round_active");
  } else {
    for (const lockKey of parsed.lockKeys) {
      const lock = sql.exec<{ round_id: string }>(
        "SELECT round_id FROM game_round_locks WHERE module_id = ? AND lock_key = ?",
        moduleId,
        lockKey,
      ).toArray()[0];
      if (lock !== undefined) throw new Error("round_locked");
    }
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
  for (const lockKey of parsed.lockKeys ?? []) {
    sql.exec("INSERT INTO game_round_locks (module_id, lock_key, round_id) VALUES (?, ?, ?)", moduleId, lockKey, roundId);
  }
  return { opened: true, alarmKey };
};

export const listOpenPointRoundsSync = (sql: PointsSql, moduleId: string): Array<{
  roundId: string;
  state: "announcing" | "open";
  data: unknown;
  deadlineAt: number | null;
}> => sql.exec<{
  round_id: string;
  state: "announcing" | "open";
  deadline_at: number | null;
  data_json: string;
}>(
  `SELECT round_id, state, deadline_at, data_json FROM game_rounds
    WHERE module_id = ? AND state IN ('announcing', 'open')
    ORDER BY created_at, round_id LIMIT 50`,
  moduleId,
).toArray().map((round) => ({
  roundId: round.round_id,
  state: round.state,
  data: JSON.parse(round.data_json) as unknown,
  deadlineAt: round.deadline_at,
}));

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
  const announcementAt = new Date(deadlineAt - row.duration_s * 1_000).toISOString();
  if (row.state === "open" && row.deadline_at === deadlineAt) {
    sql.exec("UPDATE game_rounds SET announcement_at = COALESCE(announcement_at, ?) WHERE round_id = ?", announcementAt, roundId);
    return;
  }
  if (row.state !== "announcing") throw new Error("round_closed");
  sql.exec(
    `UPDATE game_rounds SET state = 'open', announce_state = 'delivered', deadline_at = ?, announcement_at = ?, alarm_key = ?
      WHERE round_id = ? AND module_id = ? AND state = 'announcing'`,
    deadlineAt,
    announcementAt,
    alarmKey,
    roundId,
    moduleId,
  );
};

export const updatePointRoundSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  data: unknown,
  deadlineAt: number | null,
): void => {
  assertPointRoundId(roundId);
  if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) throw new Error("invalid_deadline");
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.module_id !== moduleId || (round.state !== "announcing" && round.state !== "open")) {
    throw new Error("round_closed");
  }
  sql.exec(
    "UPDATE game_rounds SET data_json = ?, deadline_at = ? WHERE round_id = ? AND module_id = ? AND state IN ('announcing', 'open')",
    jsonValue(stableValue(data)),
    deadlineAt,
    roundId,
    moduleId,
  );
};

const participantsForRoundSync = (sql: PointsSql, roundId: string): PointRoundParticipant[] =>
  sql.exec<ParticipantRow>(
    `SELECT round_id, account_id, login, stake, data_json FROM game_round_participants
      WHERE round_id = ? ORDER BY rowid`,
    roundId,
  ).toArray().map((row) => ({
    accountId: row.account_id,
    login: row.login,
    stake: row.stake,
    data: JSON.parse(row.data_json) as unknown,
  }));

export const pointRoundParticipantRecordsSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
): PointRoundParticipant[] => {
  const round = pointRoundRow(sql, roundId);
  return round === null || round.module_id !== moduleId ? [] : participantsForRoundSync(sql, roundId);
};

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
  return rounds.flatMap((roundId) => participantsForRoundSync(sql, roundId).filter(({ stake }) => stake > 0).map((participant) => {
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

export const openPointRoundWithStakeSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  value: unknown,
  operationId: string,
  accountId: string,
  login: string,
  stake: number,
  cooldown: { key: string; seconds: number } | undefined,
  requestHash: string,
  nowMs: number,
  now: string,
  settlements: ReadonlyMap<string, PointSettlement>,
): { roundId: string; replayed: boolean; alarmKey: string } => {
  assertPointAccountId(accountId);
  if (pointKindFor(accountId) !== "viewer" || login.length === 0 || !Number.isSafeInteger(stake) || stake < 1) {
    throw new Error("invalid_stake");
  }
  const previous = operationSync(sql, operationId);
  if (previous !== null) {
    if (previous.payload_hash !== requestHash) throw new Error("operation_conflict");
    const result = JSON.parse(previous.result_json) as { roundId?: unknown };
    if (typeof result.roundId !== "string") throw new Error("operation_conflict");
    const round = pointRoundRow(sql, result.roundId);
    if (round === null || round.module_id !== moduleId) throw new Error("operation_conflict");
    return { roundId: result.roundId, replayed: true, alarmKey: round.alarm_key ?? pointRoundAlarmKey(result.roundId) };
  }
  checkModuleGateSync(sql, moduleId);
  if (cooldown !== undefined && !claimPointCooldownSync(sql, moduleId, cooldown.key, cooldown.seconds, nowMs)) {
    throw new Error("cooldown");
  }
  const parsed = parseRoundOpenData(value);
  if (parsed.lockKeys !== undefined) {
    const count = sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM game_rounds WHERE module_id = ? AND state IN ('announcing', 'open')",
      moduleId,
    ).one().count;
    if (count >= 50) throw new Error("round_limit");
  }
  const opened = openPointRoundSync(sql, moduleId, roundId, value, now, settlements);
  const result = { roundId };
  applyPointOperationSync(sql, moduleId, operationId, "stake", [
    { accountId, delta: -stake, login },
    { accountId: `__escrow:${roundId}`, delta: stake },
  ], result, requestHash, now);
  sql.exec(
    `INSERT INTO game_round_participants (round_id, account_id, login, stake, data_json)
     VALUES (?, ?, ?, ?, ?)`,
    roundId,
    accountId,
    login,
    stake,
    jsonValue({ role: "challenger" }),
  );
  return { roundId, replayed: false, alarmKey: opened.alarmKey };
};

export const acceptPointRoundSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  operationId: string,
  accountId: string,
  login: string,
  requestHash: string,
  resolveHash: string,
  nowMs: number,
  now: string,
  settlements: ReadonlyMap<string, PointSettlement>,
  acceptMessageId?: string,
): PointApplyInternalResult => {
  assertPointRoundId(roundId);
  assertPointAccountId(accountId);
  const previous = operationSync(sql, operationId);
  if (previous !== null) {
    if (previous.payload_hash !== requestHash) throw new Error("operation_conflict");
    return resolvePointRoundSync(sql, moduleId, roundId, { kind: "duel", params: { mode: "accept" } }, settlements, resolveHash, now);
  }
  checkModuleGateSync(sql, moduleId);
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.module_id !== moduleId || round.state !== "open" || round.deadline_at === null || round.deadline_at <= nowMs) {
    throw new Error("round_closed");
  }
  const data = JSON.parse(round.data_json) as Record<string, unknown>;
  const challengerId = data.challengerId;
  const targetId = data.targetId;
  const stake = data.stake;
  if (typeof challengerId !== "string" || (targetId !== null && typeof targetId !== "string") ||
      !Number.isSafeInteger(stake) || (stake as number) < 1 || login.length === 0) throw new Error("invalid_round_data");
  if (accountId === challengerId || (targetId !== null && accountId !== targetId)) throw new Error("not_eligible");
  if (pointKindFor(accountId) !== "viewer") throw new Error("invalid_stake");
  if (acceptMessageId !== undefined) {
    if (acceptMessageId.length === 0 || acceptMessageId.length > 256) throw new Error("invalid_operation_id");
    data.acceptMessageId = acceptMessageId;
    data[POINT_WELCOME_RESULT_ACCOUNT_ID_KEY] = accountId;
    sql.exec("UPDATE game_rounds SET data_json = ? WHERE round_id = ? AND state = 'open'", JSON.stringify(data), roundId);
  }
  const participant = sql.exec<{ account_id: string }>(
    "SELECT account_id FROM game_round_participants WHERE round_id = ? AND account_id = ?",
    roundId,
    accountId,
  ).toArray()[0];
  if (participant !== undefined) throw new Error("not_eligible");
  applyPointOperationSync(sql, moduleId, operationId, "stake", [
    { accountId, delta: -(stake as number), login },
    { accountId: `__escrow:${roundId}`, delta: stake as number },
  ], { roundId, accountId, stake }, requestHash, now);
  sql.exec(
    `INSERT INTO game_round_participants (round_id, account_id, login, stake, data_json)
     VALUES (?, ?, ?, ?, ?)`,
    roundId,
    accountId,
    login,
    stake,
    jsonValue({ role: "acceptor" }),
  );
  const resolved = resolvePointRoundSync(
    sql,
    moduleId,
    roundId,
    { kind: "duel", params: { mode: "accept" } },
    settlements,
    resolveHash,
    now,
  );
  return resolved;
};

export const answerPointRoundSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  operationId: string,
  accountId: string,
  login: string,
  graceS: number,
  messageAt: number,
  payloadHash: string,
  nowMs: number,
  now: string,
): PointRoundAnswerResult & { deadlineAt: number | null } => {
  assertPointRoundId(roundId);
  assertPointAccountId(accountId);
  if (operationId.length === 0 || operationId.length > 200) throw new Error("invalid_operation_id");
  const previous = sql.exec<{
    module_id: string;
    round_id: string;
    account_id: string;
    status: PointRoundAnswerResult["status"];
    first_answer: number;
    payload_hash: string;
  }>("SELECT module_id, round_id, account_id, status, first_answer, payload_hash FROM game_round_answers WHERE operation_id = ?", operationId).toArray()[0];
  if (previous !== undefined) {
    if (previous.payload_hash !== payloadHash || previous.module_id !== moduleId || previous.round_id !== roundId || previous.account_id !== accountId) {
      throw new Error("operation_conflict");
    }
    return { status: previous.status, replayed: true, first: previous.first_answer === 1, deadlineAt: null };
  }
  if (pointKindFor(accountId) !== "viewer" || login.length === 0 || !Number.isSafeInteger(graceS) || graceS < 0 || graceS > 300 ||
      !Number.isSafeInteger(messageAt) || messageAt < 0) {
    throw new Error("invalid_round_answer");
  }
  checkModuleGateSync(sql, moduleId);
  const round = pointRoundRow(sql, roundId);
  let status: PointRoundAnswerResult["status"] = "round_closed";
  let first = false;
  let deadlineAt: number | null = null;
  let announcementAt: number | null = null;
  if (round !== null) {
    if (round.announcement_at !== null) announcementAt = Date.parse(round.announcement_at);
    else if (round.deadline_at !== null) announcementAt = round.deadline_at - round.duration_s * 1_000;
  }
  if (round !== null && round.module_id === moduleId && round.state === "open" && round.deadline_at !== null && round.deadline_at > nowMs &&
      (announcementAt === null || (Number.isFinite(announcementAt) && messageAt >= announcementAt))) {
    const participant = sql.exec<{ account_id: string }>(
      "SELECT account_id FROM game_round_participants WHERE round_id = ? AND account_id = ?",
      roundId,
      accountId,
    ).toArray()[0];
    if (participant !== undefined) {
      status = "already_answered";
    } else {
      const count = sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM game_round_participants WHERE round_id = ?",
        roundId,
      ).one().count;
      first = count === 0;
      status = "recorded";
      sql.exec(
        `INSERT INTO game_round_participants (round_id, account_id, login, stake, data_json)
         VALUES (?, ?, ?, 0, '{}')`,
        roundId,
        accountId,
        login,
      );
      if (first) {
        deadlineAt = Math.min(round.deadline_at, nowMs + graceS * 1_000);
        sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ? AND module_id = ? AND state = 'open'", deadlineAt, roundId, moduleId);
      }
    }
  }
  sql.exec(
    `INSERT INTO game_round_answers
      (operation_id, module_id, round_id, account_id, login, status, first_answer, payload_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    operationId,
    moduleId,
    roundId,
    accountId,
    login,
    status,
    first ? 1 : 0,
    payloadHash,
    now,
  );
  return { status, replayed: false, first, deadlineAt };
};

export const answerPointRoundChoiceSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  operationId: string,
  accountId: string,
  login: string,
  questionIndex: number,
  choice: number,
  messageAt: number,
  payloadHash: string,
  nowMs: number,
  now: string,
): PointRoundChoiceResult => {
  assertPointRoundId(roundId);
  assertPointAccountId(accountId);
  if (operationId.length === 0 || operationId.length > 200 || login.length === 0 ||
      !Number.isSafeInteger(questionIndex) || questionIndex < 0 || !Number.isSafeInteger(choice) || choice < 0 ||
      !Number.isSafeInteger(messageAt) || messageAt < 0) throw new Error("invalid_round_choice");

  const previousOperation = sql.exec<{
    module_id: string;
    round_id: string;
    account_id: string;
    status: PointRoundChoiceResult["status"];
    payload_hash: string;
  }>("SELECT module_id, round_id, account_id, status, payload_hash FROM game_round_answers WHERE operation_id = ?", operationId).toArray()[0];
  if (previousOperation !== undefined) {
    if (previousOperation.payload_hash !== payloadHash || previousOperation.module_id !== moduleId ||
        previousOperation.round_id !== roundId || previousOperation.account_id !== accountId) throw new Error("operation_conflict");
    return { status: previousOperation.status, replayed: true };
  }

  if (pointKindFor(accountId) !== "viewer") throw new Error("invalid_round_choice");
  checkModuleGateSync(sql, moduleId);
  const round = pointRoundRow(sql, roundId);
  const data = round === null ? null : JSON.parse(round.data_json) as unknown;
  const session = typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const questions = session?.questions;
  const question: unknown = Array.isArray(questions) ? questions[questionIndex] : undefined;
  const options: unknown = typeof question === "object" && question !== null && !Array.isArray(question)
    ? Reflect.get(question, "options") : undefined;
  const announcementAt = round === null
    ? null
    : round.announcement_at === null
      ? round.deadline_at === null ? null : round.deadline_at - round.duration_s * 1_000
      : Date.parse(round.announcement_at);
  const isQuizRound = moduleId === "quiz";
  const isCurrentQuizQuestion = session !== null && session.phase === "open" && session.paused !== true &&
    session.questionIndex === questionIndex && Array.isArray(options) && choice < options.length;
  const phaseOpenedAt = Number.isSafeInteger(session?.phaseOpenedAt) ? session?.phaseOpenedAt as number : announcementAt;
  const effectivePhaseEnd = isQuizRound && Number.isSafeInteger(session?.phaseEndsAt)
    ? session?.phaseEndsAt as number
    : isQuizRound ? round?.deadline_at ?? null : null;
  const isDuringAnswerWindow = round !== null && round.module_id === moduleId && round.state === "open" &&
    round.deadline_at !== null && round.deadline_at > nowMs && messageAt < round.deadline_at &&
    (!isQuizRound || effectivePhaseEnd !== null && messageAt < effectivePhaseEnd) &&
    (phaseOpenedAt === null || Number.isFinite(phaseOpenedAt) && messageAt >= phaseOpenedAt);
  const status: PointRoundChoiceResult["status"] = isCurrentQuizQuestion && isDuringAnswerWindow ? "recorded" : "round_closed";
  let first = false;
  if (status === "recorded") {
    const existing = sql.exec<{ data_json: string }>(
      "SELECT data_json FROM game_round_participants WHERE round_id = ? AND account_id = ?",
      roundId,
      accountId,
    ).toArray()[0];
    first = existing === undefined;
    const participantData = existing === undefined
      ? { answers: [] as (number | null)[] }
      : JSON.parse(existing.data_json) as { answers?: unknown };
    const answers: (number | null)[] = Array.isArray(participantData.answers)
      ? participantData.answers.map((answer: unknown) => answer === null || Number.isSafeInteger(answer) ? answer as number | null : null)
      : [];
    answers[questionIndex] = choice;
    const nextData = { answers };
    if (existing === undefined) {
      sql.exec(
        `INSERT INTO game_round_participants (round_id, account_id, login, stake, data_json)
         VALUES (?, ?, ?, 0, ?)`,
        roundId,
        accountId,
        login,
        jsonValue(nextData),
      );
    } else {
      sql.exec(
        "UPDATE game_round_participants SET login = ?, data_json = ? WHERE round_id = ? AND account_id = ?",
        login,
        jsonValue(nextData),
        roundId,
        accountId,
      );
    }
  }
  sql.exec(
    `INSERT INTO game_round_answers
      (operation_id, module_id, round_id, account_id, login, status, first_answer, payload_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    operationId,
    moduleId,
    roundId,
    accountId,
    login,
    status,
    first ? 1 : 0,
    payloadHash,
    now,
  );
  return { status, replayed: false };
};

const attackCooldownPrefix = (roundId: string): string => `round:${roundId}:attack:`;

/** Drops the stored attacks and per-viewer cooldown keys of a finished round. */
const deleteRoundAttackStateSync = (sql: PointsSql, moduleId: string, roundId: string): void => {
  sql.exec("DELETE FROM game_round_attacks WHERE module_id = ? AND round_id = ?", moduleId, roundId);
  // Cooldown keys are `<module>:round:<id>:attack:<hash>`; the range ends at the prefix with ":" bumped to ";".
  const prefix = `${moduleId}:${attackCooldownPrefix(roundId)}`;
  sql.exec("DELETE FROM game_cooldowns WHERE key >= ? AND key < ?", prefix, `${prefix.slice(0, -1)};`);
};

export const attackPointRoundSync = (
  sql: PointsSql,
  moduleId: string,
  roundId: string,
  operationId: string,
  accountId: string,
  login: string,
  damage: number,
  messageAt: number,
  payloadHash: string,
  cooldownKey: string,
  nowMs: number,
  now: string,
): PointRoundAttackResult => {
  assertPointRoundId(roundId);
  assertPointAccountId(accountId);
  if (operationId.length === 0 || operationId.length > 200) throw new Error("invalid_operation_id");
  if (pointKindFor(accountId) !== "viewer" || !/^[A-Za-z0-9_]{1,25}$/u.test(login) ||
      !Number.isSafeInteger(damage) || damage < 1 || !Number.isSafeInteger(messageAt) || messageAt < 0) {
    throw new Error("invalid_round_attack");
  }

  const previous = sql.exec<{
    module_id: string;
    round_id: string;
    result_json: string;
    payload_hash: string;
  }>("SELECT module_id, round_id, result_json, payload_hash FROM game_round_attacks WHERE operation_id = ?", operationId).toArray()[0];
  if (previous !== undefined) {
    if (previous.payload_hash !== payloadHash || previous.module_id !== moduleId || previous.round_id !== roundId) {
      throw new Error("operation_conflict");
    }
    return { ...(JSON.parse(previous.result_json) as Omit<PointRoundAttackResult, "replayed">), replayed: true };
  }

  checkModuleGateSync(sql, moduleId);
  const round = pointRoundRow(sql, roundId);
  let result: PointRoundAttackResult = {
    status: "round_closed",
    replayed: false,
    damage: 0,
    defeated: false,
    currentHp: 0,
    maxHp: 0,
    attackers: 0,
    damageDealt: 0,
  };
  const parsedData: unknown = round === null ? null : JSON.parse(round.data_json);
  const data = typeof parsedData === "object" && parsedData !== null ? parsedData as Record<string, unknown> : null;
  if (data !== null && Number.isSafeInteger(data.attackerCount) && Number.isSafeInteger(data.damageDealt) &&
      Number.isSafeInteger(data.currentHp) && Number.isSafeInteger(data.maxHp) && typeof data.defeated === "boolean") {
    result = {
      ...result,
      defeated: data.defeated,
      currentHp: data.currentHp as number,
      maxHp: data.maxHp as number,
      attackers: data.attackerCount as number,
      damageDealt: data.damageDealt as number,
    };
  }
  let announcementAt: number | null = null;
  if (round !== null) {
    if (round.announcement_at !== null) announcementAt = Date.parse(round.announcement_at);
    else if (round.deadline_at !== null) announcementAt = round.deadline_at - round.duration_s * 1_000;
  }
  const attackAllowed = round !== null && round.module_id === moduleId && round.state === "open" && round.deadline_at !== null &&
    round.deadline_at > nowMs && (announcementAt === null || Number.isFinite(announcementAt) && messageAt >= announcementAt) &&
    data !== null && data.defeated !== true && Number.isSafeInteger(data.baseHp) && (data.baseHp as number) > 0 &&
    Number.isSafeInteger(data.hpPerAttacker) && (data.hpPerAttacker as number) >= 0 &&
    Number.isSafeInteger(data.attackCooldownSeconds) && (data.attackCooldownSeconds as number) >= 1 && (data.attackCooldownSeconds as number) <= 3_600 &&
    Number.isSafeInteger(data.attackerCount) && (data.attackerCount as number) >= 0 &&
    Number.isSafeInteger(data.damageDealt) && (data.damageDealt as number) >= 0 &&
    Number.isSafeInteger(data.damageMinimum) && Number.isSafeInteger(data.damageMaximum) &&
    damage >= (data.damageMinimum as number) && damage <= (data.damageMaximum as number);

  if (attackAllowed && !claimPointCooldownSync(sql, moduleId, `${attackCooldownPrefix(roundId)}${cooldownKey}`, data.attackCooldownSeconds as number, nowMs)) {
    result = { ...result, status: "cooldown" };
  } else if (attackAllowed) {
    const participant = sql.exec<{ login: string; data_json: string }>(
      "SELECT login, data_json FROM game_round_participants WHERE round_id = ? AND account_id = ?",
      roundId,
      accountId,
    ).toArray()[0];
    let participantDamage = 0;
    if (participant !== undefined) {
      const participantData: unknown = JSON.parse(participant.data_json);
      if (typeof participantData !== "object" || participantData === null || Array.isArray(participantData) ||
          !Number.isSafeInteger((participantData as Record<string, unknown>).damage) || ((participantData as Record<string, unknown>).damage as number) < 0) {
        throw new Error("invalid_round_attack");
      }
      participantDamage = (participantData as { damage: number }).damage;
    }
    const nextDamage = participantDamage + damage;
    if (!Number.isSafeInteger(nextDamage)) throw new Error("invalid_round_attack");
    if (participant === undefined) {
      sql.exec(
        `INSERT INTO game_round_participants (round_id, account_id, login, stake, data_json)
         VALUES (?, ?, ?, 0, ?)`,
        roundId,
        accountId,
        login,
        jsonValue({ damage: nextDamage }),
      );
    } else {
      sql.exec(
        "UPDATE game_round_participants SET login = ?, data_json = ? WHERE round_id = ? AND account_id = ?",
        login,
        jsonValue({ damage: nextDamage }),
        roundId,
        accountId,
      );
    }
    // The round keeps the attacker count and damage total as aggregates, so a hit never reloads all participants.
    const totalDamage = (data.damageDealt as number) + damage;
    const attackers = (data.attackerCount as number) + (participant === undefined ? 1 : 0);
    if (!Number.isSafeInteger(totalDamage)) throw new Error("invalid_round_attack");
    const health = bossHealth({
      baseHp: data.baseHp as number,
      hpPerAttacker: data.hpPerAttacker as number,
      attackers,
      damageDealt: totalDamage,
    });
    const { maxHp, defeated, currentHp } = health;
    const nextData = {
      ...data,
      attackerCount: attackers,
      damageDealt: totalDamage,
      maxHp,
      currentHp,
      defeated,
    };
    sql.exec("UPDATE game_rounds SET data_json = ? WHERE round_id = ? AND module_id = ? AND state = 'open'", jsonValue(nextData), roundId, moduleId);
    result = { status: "hit", replayed: false, damage, defeated, currentHp, maxHp, attackers, damageDealt: totalDamage };
    // Only accepted hits are stored (for replay protection); rejected attacks leave nothing behind.
    // The rows and the cooldown keys are removed when the round resolves or is cancelled.
    sql.exec(
      `INSERT INTO game_round_attacks (operation_id, module_id, round_id, result_json, payload_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      operationId,
      moduleId,
      roundId,
      jsonValue(result),
      payloadHash,
      now,
    );
  }
  return result;
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

const jackpotForModuleSync = (sql: PointsSql, moduleId: string): Record<string, number> => {
  const accountId = `__jackpot:${moduleId}`;
  const row = sql.exec<{ balance: number }>("SELECT balance FROM point_accounts WHERE account_id = ?", accountId).toArray()[0];
  return row === undefined ? {} : { [accountId]: row.balance };
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
  const round = pointRoundRow(sql, roundId);
  const roundData = round === null ? null : JSON.parse(round.data_json) as unknown;
  const operationId = pointRoundResolveOperationId(roundId, roundData);
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
  if (round === null || round.module_id !== moduleId || round.state !== "open") throw new Error("round_closed");
  const cancellation = sql.exec<{ revision: number }>(
    "SELECT revision FROM game_round_cancellations WHERE module_id = ?",
    moduleId,
  ).toArray()[0];
  if (cancellation !== undefined) throw new Error("round_cancellation_pending");
  const handler = settlements.get(settlement.kind);
  if (handler === undefined) throw new Error("settlement_unknown");
  const participants = participantsForRoundSync(sql, roundId);
  const resolvedRoundData = roundData;
  sql.exec("UPDATE game_rounds SET state = 'resolving' WHERE round_id = ? AND state = 'open'", roundId);
  let before: Map<string, number>;
  let applied: PointApplyInternalResult;
  let settled: PointSettlementOutput;
  try {
    settled = handler({
      round: { roundId, moduleId, data: resolvedRoundData },
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
  if (settled.clearParticipantData === true) {
    sql.exec("UPDATE game_round_participants SET data_json = '{}' WHERE round_id = ?", roundId);
    sql.exec("DELETE FROM game_round_answers WHERE module_id = ? AND round_id = ?", moduleId, roundId);
  }
  sql.exec(
    `UPDATE game_rounds SET state = 'resolved', resolve_delivery_state = 'pending', resolved_at = ?
      WHERE round_id = ? AND module_id = ?`,
    now,
    roundId,
    moduleId,
  );
  sql.exec("DELETE FROM game_round_locks WHERE module_id = ? AND round_id = ?", moduleId, roundId);
  const cooldownAfter = (resolvedRoundData as PointRoundOpenData).cooldownAfter;
  if (cooldownAfter !== undefined) {
    // Same transaction as the settlement, so no restart can leave a settled round without its pause.
    sql.exec(
      `INSERT INTO game_cooldowns (key, until_at) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET until_at = excluded.until_at`,
      `${moduleId}:${cooldownAfter.key}`,
      new Date(Date.parse(now) + cooldownAfter.seconds * 1_000).toISOString(),
    );
  }
  deleteRoundAttackStateSync(sql, moduleId, roundId);
  return applied;
};

export const cancelPointRoundsSync = (
  sql: PointsSql,
  moduleId: string,
  now: string,
  hashFor: (value: unknown) => string,
  roundIds?: readonly string[],
  expectedGateRevision?: number,
  onRoundCancelled?: (roundId: string) => void,
  queueCancellationNotice = true,
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
    let clearParticipantData = false;
    if (moduleId === "quiz") {
      try {
        const roundData: unknown = JSON.parse(round.data_json);
        const rawSettlement = typeof roundData === "object" && roundData !== null && !Array.isArray(roundData)
          ? (roundData as Record<string, unknown>).settlement
          : null;
        if (typeof rawSettlement === "object" && rawSettlement !== null && !Array.isArray(rawSettlement) &&
            typeof (rawSettlement as { kind?: unknown }).kind === "string") {
          const settlement = rawSettlement as { kind: string; params: unknown };
          const handler = POINT_SETTLEMENTS.get(settlement.kind);
          if (handler !== undefined) {
            clearParticipantData = handler({
              round: { roundId, moduleId, data: roundData },
              participants: participantsForRoundSync(sql, roundId),
              pots: potsForModuleSync(sql, moduleId, roundId),
              params: settlement.params,
            }).clearParticipantData === true;
          }
        }
      } catch {
        // Cancellation must still complete when a stale round cannot produce a settlement preview.
      }
    }
    const refunds = pointRoundRefundRequests(sql, moduleId, [roundId]);
    for (const refund of refunds) {
      const payload = { moduleId, operationId: refund.operationId, kind: "refund", movements: refund.movements, result: refund.result };
      applyPointOperationSync(sql, moduleId, refund.operationId, "refund", refund.movements,
        refund.result, hashFor(payload), now);
    }
    refundedStake ||= refunds.length > 0;
    sql.exec("UPDATE game_rounds SET state = 'cancelled' WHERE round_id = ? AND module_id = ?", roundId, moduleId);
    sql.exec("DELETE FROM game_round_locks WHERE module_id = ? AND round_id = ?", moduleId, roundId);
    deleteRoundAttackStateSync(sql, moduleId, roundId);
    if (clearParticipantData) {
      sql.exec("UPDATE game_round_participants SET data_json = '{}' WHERE round_id = ?", roundId);
      sql.exec("DELETE FROM game_round_answers WHERE module_id = ? AND round_id = ?", moduleId, roundId);
    }
    onRoundCancelled?.(roundId);
    cancelledCount += 1;
  }
  if (expectedGateRevision !== undefined) {
    if (refundedStake && queueCancellationNotice) {
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
    `UPDATE game_rounds SET announce_state = 'pending', announce_attempts = ?, last_attempt_at = ?,
            announce_welcome_appended = 0, announce_welcome_claim_id = NULL,
            announce_welcome_operation_id = NULL
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
  const disposition = pointRoundDeliveryDisposition(state, round.announce_attempts);
  if (disposition === "retry") {
    sql.exec("UPDATE game_rounds SET announce_state = 'rate_limited' WHERE round_id = ?", roundId);
    return { moduleId: round.module_id, deadlineAt: null, alarmKey: round.alarm_key, cancelled: false };
  }
  if (disposition === "park") {
    sql.exec("UPDATE game_rounds SET announce_state = 'failed' WHERE round_id = ?", roundId);
    return { moduleId: round.module_id, deadlineAt: null, alarmKey: round.alarm_key, cancelled: true };
  }
  const deadlineAt = deliveredAt + round.duration_s * 1_000;
  const alarmKey = pointRoundAlarmKey(roundId);
  sql.exec(
    `UPDATE game_rounds SET announce_state = ?, state = 'open', deadline_at = ?, announcement_at = ?, alarm_key = ?
      WHERE round_id = ?`,
    state,
    deadlineAt,
    new Date(deliveredAt).toISOString(),
    alarmKey,
    roundId,
  );
  return { moduleId: round.module_id, deadlineAt, alarmKey, cancelled: false };
};

export const recoverablePointRounds = (sql: PointsSql): RoundRow[] =>
  sql.exec<RoundRow>(
    `SELECT round_id, module_id, gate_revision, state, deadline_at, announcement_at, alarm_key, data_json, created_at, duration_s,
            announce_text, announce_state, announce_attempts, last_attempt_at,
            prepare_state, resolve_delivery_state, resolve_delivery_attempts, resolve_delivery_last_attempt_at, resolved_at
       FROM game_rounds
      WHERE prepare_state = 'pending' OR state IN ('announcing', 'open')
         OR (state = 'resolved' AND resolve_delivery_state IN ('pending', 'sending'))
      ORDER BY created_at, round_id`,
  ).toArray();

export const beginPointRoundResolutionDeliverySync = (sql: PointsSql, roundId: string, now: number): {
  round: RoundRow | null;
  result: unknown;
  outcome: "attempt" | "pending" | "delivered" | "suppressed" | "failed" | "ignored";
} => {
  const prepared = pointRoundResolutionDeliverySync(sql, roundId);
  if (prepared.outcome !== "ready") {
    return { round: prepared.round, result: prepared.result, outcome: prepared.outcome };
  }
  sql.exec(
    `UPDATE game_rounds
        SET resolve_delivery_state = 'sending',
            resolve_delivery_attempts = resolve_delivery_attempts + 1,
            resolve_delivery_last_attempt_at = ?,
            resolve_welcome_appended = 0,
            resolve_welcome_claim_id = NULL,
            resolve_welcome_operation_id = NULL
      WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state = 'pending'`,
    now,
    roundId,
  );
  const round = pointRoundRow(sql, roundId);
  return {
    round,
    result: prepared.result,
    outcome: "attempt",
  };
};

export function pointRoundResolutionDeliverySync(sql: PointsSql, roundId: string): {
  round: RoundRow | null;
  result: unknown;
  outcome: "ready" | "pending" | "delivered" | "suppressed" | "failed" | "ignored";
} {
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.state !== "resolved") return { round, result: null, outcome: "ignored" };
  if (round.resolve_delivery_state === "delivered") return { round, result: null, outcome: "delivered" };
  if (round.resolve_delivery_state === "suppressed") return { round, result: null, outcome: "suppressed" };
  if (round.resolve_delivery_state === "failed") return { round, result: null, outcome: "failed" };
  if (!pointRoundDeliveryGateIsCurrentSync(sql, round)) {
    sql.exec(
      `UPDATE game_rounds SET resolve_delivery_state = 'suppressed'
        WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state IN ('pending', 'sending')`,
      roundId,
    );
    return { round: { ...round, resolve_delivery_state: "suppressed" }, result: null, outcome: "suppressed" };
  }
  if (round.resolve_delivery_state === "sending") return { round, result: null, outcome: "pending" };
  if (round.resolve_delivery_attempts >= POINTS_ANNOUNCE_MAX_ATTEMPTS) {
    sql.exec(
      `UPDATE game_rounds SET resolve_delivery_state = 'failed'
        WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state = 'pending'`,
      roundId,
    );
    return { round: { ...round, resolve_delivery_state: "failed" }, result: null, outcome: "failed" };
  }
  const operationId = pointRoundResolveOperationId(roundId, JSON.parse(round.data_json) as unknown);
  const operation = sql.exec<{ result_json: string }>(
    "SELECT result_json FROM point_operations WHERE operation_id = ? AND module_id = ?",
    operationId,
    round.module_id,
  ).toArray()[0];
  if (operation === undefined) return { round, result: null, outcome: "ignored" };
  return { round, result: JSON.parse(operation.result_json) as unknown, outcome: "ready" };
}

export const recordPointRoundResolutionPreparationFailureSync = (sql: PointsSql, roundId: string, now: number):
  RoundRow["resolve_delivery_state"] | null => {
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.state !== "resolved" ||
      (round.resolve_delivery_state !== "pending" && round.resolve_delivery_state !== "sending")) return null;
  if (!pointRoundDeliveryGateIsCurrentSync(sql, round)) {
    sql.exec(
      `UPDATE game_rounds SET resolve_delivery_state = 'suppressed'
        WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state IN ('pending', 'sending')`,
      roundId,
    );
    return "suppressed";
  }
  if (round.resolve_delivery_state === "pending" && round.resolve_delivery_attempts >= POINTS_ANNOUNCE_MAX_ATTEMPTS) {
    sql.exec(
      `UPDATE game_rounds SET resolve_delivery_state = 'failed'
        WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state = 'pending'`,
      roundId,
    );
    return "failed";
  }
  if (round.resolve_delivery_state === "pending") {
    sql.exec(
      `UPDATE game_rounds
          SET resolve_delivery_attempts = resolve_delivery_attempts + 1,
              resolve_delivery_last_attempt_at = ?
        WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state = 'pending'`,
      now,
      roundId,
    );
  } else {
    sql.exec(
      `UPDATE game_rounds SET resolve_delivery_state = 'pending', resolve_delivery_last_attempt_at = ?
        WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state = 'sending'`,
      now,
      roundId,
    );
  }
  return recordPointRoundResolutionDeliverySync(sql, roundId, "rate_limited");
};

export function recordPointRoundResolutionDeliverySync(
  sql: PointsSql,
  roundId: string,
  status: PointRoundDeliveryStatus | "suppressed",
  retryRateLimited = false,
): RoundRow["resolve_delivery_state"] | null {
  const round = pointRoundRow(sql, roundId);
  if (round === null || round.state !== "resolved") return null;
  if (round.resolve_delivery_state === "suppressed") return "suppressed";
  if (status === "rate_limited" && retryRateLimited) {
    sql.exec(
      `UPDATE game_rounds
          SET resolve_delivery_state = 'pending', resolve_delivery_attempts = MAX(0, resolve_delivery_attempts - 1)
        WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state != 'suppressed'`,
      roundId,
    );
    return "pending";
  }
  const disposition = status === "suppressed" ? "park"
    : pointRoundDeliveryDisposition(status, round.resolve_delivery_attempts);
  const state = status === "suppressed"
    ? "suppressed"
    : disposition === "retry" ? "pending"
      : disposition === "park" ? "failed"
        : "delivered";
  sql.exec(
    `UPDATE game_rounds SET resolve_delivery_state = ?
      WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state != 'suppressed'`,
    state,
    roundId,
  );
  return state;
}

export const settlementFromRoundData = (value: unknown): { kind: string; params: unknown } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const settlement = (value as PointRoundOpenData).settlement;
  return settlement === undefined ? null : settlement;
};
