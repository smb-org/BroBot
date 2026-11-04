import type { ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import type {
  HelixPoll,
  HelixPrediction,
  PollsEntry,
  PollsHelixReason,
  PollsHelixResult,
  PollsKind,
  PollsRun,
} from "./contracts";
import { snapshotFromEventSub, snapshotFromHelixPoll, snapshotFromHelixPrediction, type RunSnapshot } from "./domain/runs";
import { createPollsRepository } from "./repository";

// The Helix client lives in the worker layer; it is loaded lazily to keep the module boundary.
const loadHelix = () => import("../../worker/twitch/polls");

const POLLS_RECONCILE_INTERVAL_MS = 15_000;
const HELIX_ID_LIMIT = 5;

export type PollsActionOutcome =
  | { ok: true; run: PollsRun }
  | { ok: false; reason: PollsHelixReason | "not_found" | "not_open" | "already_active" };

const success = (run: PollsRun | null): PollsActionOutcome => run === null
  ? { ok: false, reason: "invalid_response" }
  : { ok: true, run };

const failed = (reason: PollsHelixReason | "not_found" | "not_open" | "already_active"): PollsActionOutcome => ({
  ok: false,
  reason,
});

const resultForId = <Item extends { id: string }>(items: readonly Item[], id: string): Item | null =>
  items.find((item) => item.id === id) ?? null;

const entryForStart = async (env: Env, channelId: string, entryId: string): Promise<PollsEntry | null> =>
  createPollsRepository(env.DB).getEntry(channelId, entryId);

const snapshotFromHelix = (
  kind: PollsKind,
  item: HelixPoll | HelixPrediction,
  observedAt: string,
): RunSnapshot => kind === "poll"
  ? snapshotFromHelixPoll(item as HelixPoll, observedAt)
  : snapshotFromHelixPrediction(item as HelixPrediction, observedAt);

const recordSnapshot = async (
  env: Env,
  channelId: string,
  snapshot: RunSnapshot,
): Promise<PollsRun | null> => {
  const repository = createPollsRepository(env.DB);
  await repository.upsertRunSnapshot(channelId, snapshot);
  return repository.findRunByTwitchId(channelId, snapshot.kind, snapshot.twitchId);
};

const queryByIds = async <Item extends { id: string }>(
  ids: readonly string[],
  query: (batch: string[]) => Promise<PollsHelixResult<Item[]>>,
): Promise<PollsHelixResult<Item[]>> => {
  if (ids.length === 0) return { ok: true, data: [] };
  const items: Item[] = [];
  for (let offset = 0; offset < ids.length; offset += HELIX_ID_LIMIT) {
    const result = await query(ids.slice(offset, offset + HELIX_ID_LIMIT));
    if (!result.ok) return result;
    items.push(...result.data);
  }
  return { ok: true, data: items };
};

const persistReconcileTime = async (env: Env, channelId: string, now: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO polls_reconcile_state (channel_id, last_reconciled_at) VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET last_reconciled_at = excluded.last_reconciled_at`,
  ).bind(channelId, now).run();
};

const reconcileKinds = async (
  env: Env,
  channelId: string,
  now: string,
  force: boolean,
  kinds: readonly PollsKind[],
): Promise<PollsHelixReason | "success"> => {
  const previous = await env.DB.prepare(
    "SELECT last_reconciled_at FROM polls_reconcile_state WHERE channel_id = ?",
  ).bind(channelId).first<{ last_reconciled_at: string }>();
  const previousAt = previous === null ? NaN : Date.parse(previous.last_reconciled_at);
  const nowAt = Date.parse(now);
  if (!force && previous !== null && Number.isFinite(previousAt) && Number.isFinite(nowAt) &&
      nowAt - previousAt < POLLS_RECONCILE_INTERVAL_MS) return "success";

  const repository = createPollsRepository(env.DB);
  const openRuns = await repository.listOpenRuns(channelId);
  let firstFailure: PollsHelixReason | null = null;
  const { getPolls, getPredictions } = await loadHelix();

  for (const kind of kinds) {
    const openOfKind = openRuns.filter((run) => run.kind === kind);
    const twitchIds = [...new Set(openOfKind.map((run) => run.twitchId))];
    const byId = kind === "poll"
      ? await queryByIds(twitchIds, (ids) => getPolls(env, channelId, ids))
      : await queryByIds(twitchIds, (ids) => getPredictions(env, channelId, ids));
    const recent = kind === "poll"
      ? await getPolls(env, channelId, [])
      : await getPredictions(env, channelId, []);

    if (!byId.ok) firstFailure ??= byId.reason;
    if (!recent.ok) firstFailure ??= recent.reason;
    if (byId.ok) {
      const foundIds = new Set(byId.data.map(({ id }) => id));
      const missing = openOfKind.filter(({ twitchId }) => !foundIds.has(twitchId)).map(({ twitchId }) => twitchId);
      await repository.markRunsUnknown(channelId, kind, missing);
      for (const item of byId.data) {
        await repository.upsertRunSnapshot(channelId, snapshotFromHelix(kind, item, now));
      }
    }
    if (recent.ok) {
      for (const item of recent.data) {
        await repository.upsertRunSnapshot(channelId, snapshotFromHelix(kind, item, now));
      }
    }
  }

  await persistReconcileTime(env, channelId, now);
  return firstFailure ?? "success";
};

export const processPollsEvent = async (
  event: ModuleEvent,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  const snapshot = snapshotFromEventSub(
    event.subscriptionType,
    event.payload,
    event.eventSubTimestamp ?? event.receivedAt,
  );
  if (snapshot !== null) {
    await createPollsRepository(context.DB).upsertRunSnapshot(event.channelId, {
      ...snapshot,
      source: "twitch",
    });
  }
  return { actions: [], diagnostics: [] };
};

export const startEntry = async (
  env: Env,
  channelId: string,
  entryId: string,
  now: string,
): Promise<PollsActionOutcome> => {
  const repository = createPollsRepository(env.DB);
  const entry = await entryForStart(env, channelId, entryId);
  if (entry === null) return failed("not_found");

  const openOfKind = (await repository.listOpenRuns(channelId)).filter((run) => run.kind === entry.kind);
  if (openOfKind.length > 0) {
    await reconcileKinds(env, channelId, now, true, [entry.kind]);
    if ((await repository.listOpenRuns(channelId)).some((run) => run.kind === entry.kind)) {
      return failed("already_active");
    }
  }

  const { createPoll, createPrediction } = await loadHelix();
  const helix = entry.kind === "poll"
    ? await createPoll(env, channelId, entry)
    : await createPrediction(env, channelId, entry);
  if (!helix.ok) {
    if (helix.reason === "already_active") {
      await reconcileKinds(env, channelId, now, true, [entry.kind]);
      return failed("already_active");
    }
    return failed(helix.reason);
  }
  const item = helix.data[0];
  if (item === undefined) return failed("invalid_response");

  const snapshot = {
    ...snapshotFromHelix(entry.kind, item, now),
    source: "brobot" as const,
    entryId: entry.id,
  };
  const run = await recordSnapshot(env, channelId, snapshot);
  await repository.markEntryStarted(channelId, entry.id, now);
  return success(run);
};

const runForAction = async (
  env: Env,
  channelId: string,
  runId: string,
  kind: PollsKind,
  statuses: readonly PollsRun["status"][],
): Promise<PollsRun | PollsActionOutcome> => {
  const run = await createPollsRepository(env.DB).findRunById(channelId, runId);
  if (run === null) return failed("not_found");
  if (run.kind !== kind || !statuses.includes(run.status)) return failed("not_open");
  return run;
};

const isActionFailure = (value: PollsRun | PollsActionOutcome): value is PollsActionOutcome => "ok" in value;

export const endPollRun = async (env: Env, channelId: string, runId: string): Promise<PollsActionOutcome> => {
  const current = await runForAction(env, channelId, runId, "poll", ["active"]);
  if (isActionFailure(current)) return current;
  const helix = await (await loadHelix()).endPoll(env, channelId, current.twitchId, "TERMINATED");
  if (!helix.ok) return failed(helix.reason);
  const item = resultForId(helix.data, current.twitchId);
  if (item === null) return failed("invalid_response");
  return success(await recordSnapshot(env, channelId, snapshotFromHelixPoll(item, new Date().toISOString())));
};

export const lockPredictionRun = async (env: Env, channelId: string, runId: string): Promise<PollsActionOutcome> => {
  const current = await runForAction(env, channelId, runId, "prediction", ["active"]);
  if (isActionFailure(current)) return current;
  const helix = await (await loadHelix()).patchPrediction(env, channelId, current.twitchId, { status: "LOCKED" });
  if (!helix.ok) return failed(helix.reason);
  const item = resultForId(helix.data, current.twitchId);
  if (item === null) return failed("invalid_response");
  return success(await recordSnapshot(env, channelId, snapshotFromHelixPrediction(item, new Date().toISOString())));
};

export const cancelPredictionRun = async (env: Env, channelId: string, runId: string): Promise<PollsActionOutcome> => {
  const current = await runForAction(env, channelId, runId, "prediction", ["active", "locked"]);
  if (isActionFailure(current)) return current;
  const helix = await (await loadHelix()).patchPrediction(env, channelId, current.twitchId, { status: "CANCELED" });
  if (!helix.ok) return failed(helix.reason);
  const item = resultForId(helix.data, current.twitchId);
  if (item === null) return failed("invalid_response");
  return success(await recordSnapshot(env, channelId, snapshotFromHelixPrediction(item, new Date().toISOString())));
};

export const resolvePredictionRun = async (
  env: Env,
  channelId: string,
  runId: string,
  winningChoiceId: string,
): Promise<PollsActionOutcome> => {
  const repository = createPollsRepository(env.DB);
  const current = await repository.findRunById(channelId, runId);
  if (current === null) return failed("not_found");
  if (current.kind !== "prediction") return failed("not_open");

  const observedAt = new Date().toISOString();
  const { getPredictions, patchPrediction } = await loadHelix();
  const fresh = await getPredictions(env, channelId, [current.twitchId]);
  if (!fresh.ok) return failed(fresh.reason);
  const freshPrediction = resultForId(fresh.data, current.twitchId);
  if (freshPrediction === null) {
    await repository.markRunsUnknown(channelId, "prediction", [current.twitchId]);
    return failed("not_open");
  }
  await repository.upsertRunSnapshot(channelId, snapshotFromHelixPrediction(freshPrediction, observedAt));
  const refreshed = await repository.findRunById(channelId, runId);
  if (refreshed === null || (refreshed.status !== "active" && refreshed.status !== "locked")) return failed("not_open");
  if (!refreshed.choices.some(({ id }) => id === winningChoiceId)) return failed("invalid_input");

  const patched = await patchPrediction(env, channelId, refreshed.twitchId, {
    status: "RESOLVED",
    winningOutcomeId: winningChoiceId,
  });
  if (!patched.ok) return failed(patched.reason);
  const resolved = resultForId(patched.data, refreshed.twitchId);
  if (resolved === null) return failed("invalid_response");
  return success(await recordSnapshot(env, channelId, snapshotFromHelixPrediction(resolved, new Date().toISOString())));
};

export const reconcile = async (
  env: Env,
  channelId: string,
  now: string,
  options: { force: boolean },
): Promise<PollsHelixReason | "success"> => reconcileKinds(env, channelId, now, options.force, ["poll", "prediction"]);

export const loadFreshPrediction = async (
  env: Env,
  channelId: string,
  runId: string,
): Promise<PollsActionOutcome> => {
  const repository = createPollsRepository(env.DB);
  const current = await repository.findRunById(channelId, runId);
  if (current === null) return failed("not_found");
  if (current.kind !== "prediction") return failed("not_open");
  const fresh = await (await loadHelix()).getPredictions(env, channelId, [current.twitchId]);
  if (!fresh.ok) return failed(fresh.reason);
  const item = resultForId(fresh.data, current.twitchId);
  if (item === null) return failed("not_found");
  return success(await recordSnapshot(env, channelId, snapshotFromHelixPrediction(item, new Date().toISOString())));
};
