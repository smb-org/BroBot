import type {
  BallotFreezeCondition,
  BallotFreezeResult,
  BallotCastResult,
  BallotSnapshot,
} from "../../modules/contract";

export const BALLOT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const BALLOT_EXPIRY_ALARM_HANDLER = "host:ballot_expiry";

const ACTIVE_BALLOT_KEY = "ballot:active";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

interface ActiveBallot {
  moduleId: string;
  ballotId: string;
}

interface ActiveBallotExpiry extends ActiveBallot {
  expiresAt: number;
}

type StoredBallotOpenResult =
  | { status: "opened" }
  | { status: "busy"; moduleId: string; activeBallot?: ActiveBallotExpiry };

interface StoredBallot {
  moduleId: string;
  ballotId: string;
  key: Uint8Array;
  optionCount: number;
  counts: number[];
  revision: number;
  frozen?: boolean;
  openedAt: number;
  expiresAt: number;
}

type BallotStorage = Pick<DurableObjectStorage, "get" | "list" | "put" | "delete" | "transaction">;
type BallotTransaction = Pick<
  DurableObjectTransaction,
  "get" | "list" | "put" | "delete" | "setAlarm" | "deleteAlarm"
>;

const validId = (value: string, name: string): void => {
  if (!ID_PATTERN.test(value)) throw new RangeError(`${name} is invalid.`);
};

const ballotKey = (moduleId: string, ballotId: string): string => `ballot:${moduleId}:${ballotId}`;
const closedBallotKey = (moduleId: string, ballotId: string): string => `ballot:closed:${moduleId}:${ballotId}`;
const voterPrefix = (moduleId: string, ballotId: string): string => `${ballotKey(moduleId, ballotId)}:v:`;

const snapshotOf = (ballot: StoredBallot): BallotSnapshot => ({
  counts: [...ballot.counts],
  revision: ballot.revision,
});

const isBallotSnapshot = (value: unknown): value is BallotSnapshot => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const snapshot = value as Partial<BallotSnapshot>;
  return Array.isArray(snapshot.counts) && snapshot.counts.length >= 1 && snapshot.counts.length <= 9 &&
    snapshot.counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    Number.isSafeInteger(snapshot.revision) && (snapshot.revision ?? -1) >= 0;
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const isStoredBallot = (value: unknown): value is StoredBallot => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ballot = value as Partial<StoredBallot>;
  return typeof ballot.moduleId === "string" && typeof ballot.ballotId === "string" &&
    ballot.key instanceof Uint8Array && ballot.key.byteLength === 32 &&
    Number.isInteger(ballot.optionCount) && (ballot.optionCount ?? 0) >= 1 && (ballot.optionCount ?? 0) <= 9 &&
    Array.isArray(ballot.counts) && ballot.counts.length === ballot.optionCount &&
    ballot.counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    Number.isSafeInteger(ballot.revision) && (ballot.revision ?? -1) >= 0 &&
    (ballot.frozen === undefined || typeof ballot.frozen === "boolean") &&
    Number.isFinite(ballot.openedAt) && Number.isFinite(ballot.expiresAt);
};

const isActiveBallot = (value: unknown): value is ActiveBallot => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const active = value as Partial<ActiveBallot>;
  return typeof active.moduleId === "string" && typeof active.ballotId === "string";
};

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Computes a ballot-local voter key without retaining the Twitch user id. */
export const ballotVoterHash = async (
  keyBytes: Uint8Array,
  channelId: string,
  userId: string,
): Promise<string> => {
  if (keyBytes.byteLength !== 32) throw new RangeError("Ballot HMAC keys must contain 32 bytes.");
  const encoder = new TextEncoder();
  const channelBytes = encoder.encode(channelId);
  const userBytes = encoder.encode(userId);
  const input = new Uint8Array(4 + channelBytes.byteLength + userBytes.byteLength);
  new DataView(input.buffer).setUint32(0, channelBytes.byteLength, false);
  input.set(channelBytes, 4);
  input.set(userBytes, 4 + channelBytes.byteLength);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(keyBytes).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, input));
};

export const ballotExpiryAlarmKey = (moduleId: string, ballotId: string): string => {
  validId(moduleId, "Module id");
  validId(ballotId, "Ballot id");
  return `${BALLOT_EXPIRY_ALARM_HANDLER}:${moduleId}:${ballotId}`;
};

export const ballotIdentityFromExpiryAlarmKey = (key: string): ActiveBallot | null => {
  const match = /^host:ballot_expiry:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$/u.exec(key);
  const moduleId = match?.[1];
  const ballotId = match?.[2];
  return moduleId === undefined || ballotId === undefined ? null : { moduleId, ballotId };
};

export const openStoredBallot = async (
  storage: BallotStorage,
  moduleId: string,
  ballotId: string,
  optionCount: number,
  expiresAt: number,
  onOpened?: (transaction: BallotTransaction) => Promise<void>,
): Promise<StoredBallotOpenResult> => {
  validId(moduleId, "Module id");
  validId(ballotId, "Ballot id");
  if (!Number.isInteger(optionCount) || optionCount < 1 || optionCount > 9) {
    throw new RangeError("Ballots require between one and nine options.");
  }
  const requestedAt = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= requestedAt || expiresAt > requestedAt + BALLOT_MAX_LIFETIME_MS) {
    throw new RangeError("Ballot expiry must be in the next 24 hours.");
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  return await storage.transaction(async (transaction) => {
    const now = Date.now();
    if (expiresAt <= now) throw new RangeError("Ballot expiry must be in the next 24 hours.");
    const active = await transaction.get<ActiveBallot>(ACTIVE_BALLOT_KEY);
    if (active !== undefined) {
      const validActive = isActiveBallot(active) && ID_PATTERN.test(active.moduleId) && ID_PATTERN.test(active.ballotId);
      const activeKey = validActive ? ballotKey(active.moduleId, active.ballotId) : null;
      const activeStored = activeKey === null ? undefined : await transaction.get(activeKey);
      if (activeKey !== null && isStoredBallot(activeStored) &&
          activeStored.moduleId === active.moduleId && activeStored.ballotId === active.ballotId &&
          (activeStored.frozen === true || activeStored.expiresAt > now)) {
        return {
          status: "busy",
          moduleId: active.moduleId,
          activeBallot: { moduleId: active.moduleId, ballotId: active.ballotId, expiresAt: activeStored.expiresAt },
        };
      }
      if (validActive) {
        await deleteBallotData(transaction, active.moduleId, active.ballotId);
      } else {
        await transaction.delete(ACTIVE_BALLOT_KEY);
      }
    }
    const ballot: StoredBallot = {
      moduleId,
      ballotId,
      key,
      optionCount,
      counts: Array.from({ length: optionCount }, () => 0),
      revision: 0,
      frozen: false,
      openedAt: now,
      expiresAt,
    };
    await transaction.put(ACTIVE_BALLOT_KEY, { moduleId, ballotId } satisfies ActiveBallot);
    await transaction.put(ballotKey(moduleId, ballotId), ballot);
    if (onOpened !== undefined) await onOpened(transaction);
    return { status: "opened" };
  });
};

export const castStoredBallot = async (
  storage: BallotStorage,
  channelId: string,
  moduleId: string,
  ballotId: string,
  userId: string,
  choice: number,
): Promise<BallotCastResult> => {
  validId(moduleId, "Module id");
  validId(ballotId, "Ballot id");
  const stored = await storage.get(ballotKey(moduleId, ballotId));
  if (!isStoredBallot(stored) || stored.moduleId !== moduleId || stored.ballotId !== ballotId) {
    return { status: "not_open", counts: [], revision: 0 };
  }
  const choiceIsValid = Number.isInteger(choice) && choice >= 1 && choice <= stored.optionCount;
  const initiallyExpired = stored.expiresAt <= Date.now();
  if (!initiallyExpired && !choiceIsValid) return { status: "not_open", counts: [], revision: 0 };
  const voteKey = initiallyExpired
    ? null
    : `${voterPrefix(moduleId, ballotId)}${await ballotVoterHash(stored.key, channelId, userId)}`;
  return await storage.transaction(async (transaction) => {
    const ballot = await transaction.get(ballotKey(moduleId, ballotId));
    if (!isStoredBallot(ballot) || ballot.moduleId !== moduleId || ballot.ballotId !== ballotId ||
        !equalBytes(ballot.key, stored.key)) {
      return { status: "not_open", counts: [], revision: 0 };
    }
    if (ballot.frozen === true) return { status: "not_open", counts: [], revision: 0 };
    if (ballot.expiresAt <= Date.now()) {
      await deleteBallotData(transaction, moduleId, ballotId);
      return { status: "not_open", counts: [], revision: 0 };
    }
    if (!choiceIsValid || voteKey === null) return { status: "not_open", counts: [], revision: 0 };
    const active = await transaction.get<ActiveBallot>(ACTIVE_BALLOT_KEY);
    if (active?.moduleId !== moduleId || active.ballotId !== ballotId) {
      return { status: "not_open", counts: [], revision: 0 };
    }
    const previous = await transaction.get<number>(voteKey);
    if (previous === choice) return { status: "unchanged", ...snapshotOf(ballot) };
    const counts = [...ballot.counts];
    if (previous !== undefined && Number.isInteger(previous) && previous >= 1 && previous <= ballot.optionCount) {
      const previousIndex = previous - 1;
      counts[previousIndex] = (counts[previousIndex] ?? 0) - 1;
    }
    const choiceIndex = choice - 1;
    counts[choiceIndex] = (counts[choiceIndex] ?? 0) + 1;
    const updated: StoredBallot = { ...ballot, counts, revision: ballot.revision + 1 };
    await transaction.put(voteKey, choice);
    await transaction.put(ballotKey(moduleId, ballotId), updated);
    return { status: previous === undefined ? "counted" : "changed", ...snapshotOf(updated) };
  });
};

export const readStoredBallot = async (
  storage: BallotStorage,
  moduleId: string,
  ballotId: string,
): Promise<BallotSnapshot | null> => {
  validId(moduleId, "Module id");
  validId(ballotId, "Ballot id");
  return await storage.transaction(async (transaction) => {
    const ballot = await transaction.get(ballotKey(moduleId, ballotId));
    if (!isStoredBallot(ballot) || ballot.moduleId !== moduleId || ballot.ballotId !== ballotId) return null;
    if (ballot.frozen === true) return snapshotOf(ballot);
    if (ballot.expiresAt <= Date.now()) {
      await deleteBallotData(transaction, moduleId, ballotId);
      return null;
    }
    return snapshotOf(ballot);
  });
};

const deleteVoters = async (
  transaction: BallotTransaction,
  moduleId: string,
  ballotId: string,
): Promise<void> => {
  const prefix = voterPrefix(moduleId, ballotId);
  let startAfter: string | undefined;
  do {
    const entries = await transaction.list({ prefix, ...(startAfter === undefined ? {} : { startAfter }), limit: 128 });
    const keys = [...entries.keys()];
    if (keys.length === 0) return;
    await transaction.delete(keys);
    startAfter = keys.at(-1);
  } while (startAfter !== undefined);
};

const deleteBallotData = async (
  transaction: BallotTransaction,
  moduleId: string,
  ballotId: string,
): Promise<void> => {
  await deleteVoters(transaction, moduleId, ballotId);
  await transaction.delete(ballotKey(moduleId, ballotId));
  const active = await transaction.get<ActiveBallot>(ACTIVE_BALLOT_KEY);
  if (active?.moduleId === moduleId && active.ballotId === ballotId) await transaction.delete(ACTIVE_BALLOT_KEY);
};

/** Removes a ballot only after its expiry, returning a later deadline for stale alarms. */
export const expireStoredBallot = async (
  storage: BallotStorage,
  moduleId: string,
  ballotId: string,
): Promise<number | null> => {
  validId(moduleId, "Module id");
  validId(ballotId, "Ballot id");
  return await storage.transaction(async (transaction) => {
    const ballot = await transaction.get(ballotKey(moduleId, ballotId));
    if (!isStoredBallot(ballot) || ballot.moduleId !== moduleId || ballot.ballotId !== ballotId) return null;
    if (ballot.frozen === true) return null;
    if (ballot.expiresAt > Date.now()) return ballot.expiresAt;
    await deleteBallotData(transaction, moduleId, ballotId);
    return null;
  });
};

export const closeStoredBallot = async (
  storage: BallotStorage,
  moduleId: string,
  ballotId: string,
): Promise<BallotSnapshot | null> => {
  validId(moduleId, "Module id");
  validId(ballotId, "Ballot id");
  return await storage.transaction(async (transaction) => {
    const ballot = await transaction.get(ballotKey(moduleId, ballotId));
    if (!isStoredBallot(ballot) || ballot.moduleId !== moduleId || ballot.ballotId !== ballotId) {
      const closed = await transaction.get(closedBallotKey(moduleId, ballotId));
      return isBallotSnapshot(closed) ? { counts: [...closed.counts], revision: closed.revision } : null;
    }
    const snapshot = snapshotOf(ballot);
    await deleteBallotData(transaction, moduleId, ballotId);
    await transaction.put(closedBallotKey(moduleId, ballotId), snapshot);
    return snapshot;
  });
};

/** Drops the retry snapshot after the owning module has persisted its result. */
export const forgetClosedStoredBallot = async (
  storage: BallotStorage,
  moduleId: string,
  ballotId: string,
): Promise<void> => {
  validId(moduleId, "Module id");
  validId(ballotId, "Ballot id");
  await storage.transaction(async (transaction) => {
    await transaction.delete(closedBallotKey(moduleId, ballotId));
  });
};

/** Freezes a ballot in place when its transactionally read counts satisfy a data-only condition. */
export const freezeStoredBallot = async (
  storage: BallotStorage,
  moduleId: string,
  ballotId: string,
  condition: BallotFreezeCondition,
): Promise<BallotFreezeResult> => {
  validId(moduleId, "Module id");
  validId(ballotId, "Ballot id");
  if (!Number.isSafeInteger(condition.positiveOptionIndex) ||
      !Number.isSafeInteger(condition.negativeOptionIndex) || condition.positiveOptionIndex < 0 ||
      condition.negativeOptionIndex < 0 || condition.positiveOptionIndex === condition.negativeOptionIndex ||
      !Number.isSafeInteger(condition.threshold) || condition.threshold < 1) {
    throw new Error("Ballot freeze condition is invalid.");
  }
  return await storage.transaction(async (transaction) => {
    const ballot = await transaction.get(ballotKey(moduleId, ballotId));
    if (!isStoredBallot(ballot) || ballot.moduleId !== moduleId || ballot.ballotId !== ballotId) {
      return { status: "not_open", counts: [], revision: 0 };
    }
    if (ballot.frozen === true) return { status: "frozen", ...snapshotOf(ballot) };
    if (ballot.expiresAt <= Date.now()) {
      await deleteBallotData(transaction, moduleId, ballotId);
      return { status: "not_open", counts: [], revision: ballot.revision };
    }
    const snapshot = snapshotOf(ballot);
    if (condition.positiveOptionIndex >= snapshot.counts.length || condition.negativeOptionIndex >= snapshot.counts.length) {
      throw new RangeError("Ballot freeze option index is outside the ballot.");
    }
    if ((snapshot.counts[condition.positiveOptionIndex] ?? 0) -
        (snapshot.counts[condition.negativeOptionIndex] ?? 0) < condition.threshold) {
      return { status: "open", ...snapshot };
    }
    const frozen: StoredBallot = { ...ballot, frozen: true };
    await transaction.put(ballotKey(moduleId, ballotId), frozen);
    return { status: "frozen", ...snapshotOf(frozen) };
  });
};
