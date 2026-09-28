import {
  AUTOMATED_CHAT_OUTPUT_INTERVAL_MS,
  AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY,
  claimAutomatedChatOutputInTransaction,
} from "./automated-chat-output";

export const MODULE_ALARM_SEND_CLAIMS_STORAGE_KEY = "module_alarm:send_claims";
export const MODULE_ALARM_SEND_LAST_ATTEMPT_STORAGE_KEY = AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY;
export const MODULE_ALARM_SEND_CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MODULE_ALARM_SEND_INTERVAL_MS = AUTOMATED_CHAT_OUTPUT_INTERVAL_MS;

export type ModuleAlarmDelivery = "sent" | "rejected" | "ambiguous";
export type ModuleAlarmSendClaim = { status: "sending" | "sent"; at: number };

interface ClaimTransaction {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface ClaimStorage {
  get(key: string): Promise<unknown>;
  transaction<Result>(closure: (transaction: ClaimTransaction) => Promise<Result>): Promise<Result>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const timestampOf = (value: unknown): number => typeof value === "number"
  ? value
  : isRecord(value) && typeof value.at === "number" ? value.at : Number.NaN;

export const claimModuleAlarmSend = async (
  storage: ClaimStorage,
  occurrenceKey: string,
  now: number,
): Promise<boolean | "rate_limited"> => storage.transaction(async (transaction) => {
  const stored = await transaction.get(MODULE_ALARM_SEND_CLAIMS_STORAGE_KEY);
  const previousClaims = isRecord(stored) ? stored : {};
  const cutoff = now - MODULE_ALARM_SEND_CLAIM_RETENTION_MS;
  const claims = Object.fromEntries(Object.entries(previousClaims).filter(([, value]) => timestampOf(value) >= cutoff));
  if (Object.hasOwn(claims, occurrenceKey)) return false;
  if (!await claimAutomatedChatOutputInTransaction(transaction, now)) return "rate_limited";
  claims[occurrenceKey] = { status: "sending", at: now } satisfies ModuleAlarmSendClaim;
  await transaction.put(MODULE_ALARM_SEND_CLAIMS_STORAGE_KEY, claims);
  return true;
});

export const finishModuleAlarmSend = async (
  storage: ClaimStorage,
  occurrenceKey: string,
  delivery: ModuleAlarmDelivery,
  now: number,
): Promise<void> => storage.transaction(async (transaction) => {
  const stored = await transaction.get(MODULE_ALARM_SEND_CLAIMS_STORAGE_KEY);
  const claims = isRecord(stored) ? stored : {};
  const current = claims[occurrenceKey];
  if (!isRecord(current) || current.status !== "sending") return;
  if (delivery === "rejected") Reflect.deleteProperty(claims, occurrenceKey);
  else if (delivery === "sent") claims[occurrenceKey] = { status: "sent", at: now } satisfies ModuleAlarmSendClaim;
  await transaction.put(MODULE_ALARM_SEND_CLAIMS_STORAGE_KEY, claims);
});

export const readModuleAlarmSendClaim = async (
  storage: ClaimStorage,
  occurrenceKey: string,
): Promise<ModuleAlarmSendClaim | null> => {
  const stored = await storage.get(MODULE_ALARM_SEND_CLAIMS_STORAGE_KEY);
  if (!isRecord(stored)) return null;
  const claim = stored[occurrenceKey];
  if (!isRecord(claim) || (claim.status !== "sending" && claim.status !== "sent") || typeof claim.at !== "number") return null;
  return { status: claim.status, at: claim.at };
};
