import type {
  BallotCastResult,
  BallotFinalizeResult,
  BallotFinalizeRule,
  ModuleBallotAccess,
  ModuleDryRunBallotSnapshot,
  ModuleDryRunContext,
} from "../contract";
import { BALLOT_MAX_TEXT_TERMS } from "./ballots";

export interface DryRunBallotSimulationOptions {
  initialRules?: ReadonlyMap<string, BallotFinalizeRule>;
  isBlockedFreeTextVote?: (term: string, blockedTerms: readonly string[]) => boolean;
}

/** Simulates ballot mutations in memory while reading the running snapshot through read-only RPCs. */
export const createDryRunBallotAccess = (
  context: ModuleDryRunContext,
  options: DryRunBallotSimulationOptions = {},
): ModuleBallotAccess => {
  const snapshots = new Map<string, ModuleDryRunBallotSnapshot>();
  const rules = new Map<string, BallotFinalizeRule | undefined>();
  for (const [ballotId, rule] of options.initialRules ?? []) rules.set(ballotId, rule);
  const expiresAt = new Map<string, number>();
  const voterChoices = new Map<string, Map<string, number | string>>();

  const snapshotFor = async (ballotId: string): Promise<ModuleDryRunBallotSnapshot | null> => {
    const projected = snapshots.get(ballotId);
    if (projected !== undefined) return projected;
    const snapshot = await context.ballots?.readSnapshot(ballotId) ?? null;
    if (snapshot !== null) snapshots.set(ballotId, snapshot);
    return snapshot;
  };

  const hasOpenBallotSnapshot = async (): Promise<boolean> => {
    if ([...snapshots.values()].some(({ outcome }) => outcome === undefined)) return true;
    return await context.ballots?.hasOpenBallotSnapshot() ?? false;
  };

  const voterMapFor = (ballotId: string): Map<string, number | string> => {
    let voters = voterChoices.get(ballotId);
    if (voters === undefined) {
      voters = new Map();
      voterChoices.set(ballotId, voters);
    }
    return voters;
  };

  return {
    open: async (ballotId, optionCount, deadline, rule, termFilter) => {
      if (await hasOpenBallotSnapshot()) return { status: "busy", moduleId: "active" };
      rules.set(ballotId, rule);
      expiresAt.set(ballotId, deadline);
      snapshots.set(ballotId, {
        counts: Array.from({ length: optionCount }, () => 0),
        revision: 0,
        ...(optionCount === 0 ? {
          terms: [],
          more: 0,
          termFilterReady: termFilter?.blockedTerms != null,
          blockedTerms: termFilter?.blockedTerms === null ? null : [...(termFilter?.blockedTerms ?? [])],
        } : {}),
      });
      return { status: "opened" };
    },
    cast: async (ballotId, userId, choice, castOptions): Promise<BallotCastResult> => {
      const snapshot = await snapshotFor(ballotId);
      if (snapshot === null || snapshot.outcome !== undefined ||
          !Number.isInteger(choice) || choice < 1 || choice > snapshot.counts.length ||
          (expiresAt.get(ballotId) ?? Number.POSITIVE_INFINITY) <= Date.now()) {
        return { status: "not_open", counts: [], revision: 0 };
      }
      const voters = voterMapFor(ballotId);
      const previous = voters.get(userId);
      if (castOptions?.onlyIfNew === true && previous !== undefined || previous === choice) {
        return { status: "unchanged", ...snapshot };
      }
      const counts = [...snapshot.counts];
      if (typeof previous === "number" && previous >= 1 && previous <= counts.length) {
        counts[previous - 1] = Math.max(0, (counts[previous - 1] ?? 0) - 1);
      }
      counts[choice - 1] = (counts[choice - 1] ?? 0) + 1;
      const updated = { ...snapshot, counts, revision: snapshot.revision + 1 };
      voters.set(userId, choice);
      snapshots.set(ballotId, updated);
      return { status: previous === undefined ? "counted" : "changed", ...updated };
    },
    castTerm: async (ballotId, userId, term, matchText = term): Promise<BallotCastResult> => {
      const snapshot = await snapshotFor(ballotId);
      if (snapshot === null || snapshot.outcome !== undefined || typeof matchText !== "string" ||
          Array.from(term).length > 25 || term.trim().length === 0 || Array.from(matchText).length > 500 ||
          (expiresAt.get(ballotId) ?? Number.POSITIVE_INFINITY) <= Date.now()) {
        return { status: "not_open", counts: [], revision: 0 };
      }
      const blockedTerms = snapshot.blockedTerms ?? [];
      const blocked = (options.isBlockedFreeTextVote?.(term, blockedTerms) ?? false) ||
        (options.isBlockedFreeTextVote?.(matchText, blockedTerms) ?? false);
      const voters = voterMapFor(ballotId);
      const previous = voters.get(userId);
      const terms = new Map((snapshot.terms ?? []).map((entry) => [entry.term, { ...entry }]));
      if (previous === term && !blocked && terms.has(term)) return { status: "unchanged", ...snapshot };
      if (blocked) return { status: "blocked", ...snapshot };
      if (typeof previous === "string") {
        const previousEntry = terms.get(previous);
        if (previousEntry !== undefined) {
          if (previousEntry.count > 1) terms.set(previous, { ...previousEntry, count: previousEntry.count - 1 });
          else terms.delete(previous);
        }
      }
      const existing = terms.get(term);
      if (existing === undefined && terms.size >= BALLOT_MAX_TEXT_TERMS) {
        const updated = { ...snapshot, more: Math.min(Number.MAX_SAFE_INTEGER, (snapshot.more ?? 0) + 1), revision: snapshot.revision + 1 };
        snapshots.set(ballotId, updated);
        return { status: "overflow", ...updated };
      }
      if (existing === undefined) terms.set(term, { term, count: 1, approved: false });
      else terms.set(term, { ...existing, count: existing.count + 1 });
      const updated = { ...snapshot, terms: [...terms.values()], revision: snapshot.revision + 1 };
      snapshots.set(ballotId, updated);
      voters.set(userId, term);
      return { status: previous === undefined ? "counted" : "changed", ...updated };
    },
    read: snapshotFor,
    readSnapshot: snapshotFor,
    hasOpenBallot: hasOpenBallotSnapshot,
    hasOpenBallotSnapshot,
    close: snapshotFor,
    finalize: async (ballotId): Promise<BallotFinalizeResult> => {
      const snapshot = await snapshotFor(ballotId);
      if (snapshot === null) return { outcome: "not_open", counts: [], revision: 0 };
      if (snapshot.outcome !== undefined) return { ...snapshot, outcome: snapshot.outcome };
      const rule = rules.get(ballotId);
      const passed = rule !== undefined &&
        (snapshot.counts[rule.passIf.yes] ?? 0) - (snapshot.counts[rule.passIf.no] ?? 0) >= rule.passIf.netAtLeast;
      const expired = (expiresAt.get(ballotId) ?? Number.POSITIVE_INFINITY) <= Date.now();
      return { ...snapshot, outcome: passed ? "passed" : expired ? "expired" : "open" };
    },
    setBlockedTerms: async (ballotId, blockedTerms) => {
      const snapshot = await snapshotFor(ballotId);
      if (snapshot === null || snapshot.outcome !== undefined) return null;
      const updated = { ...snapshot, blockedTerms: [...blockedTerms], termFilterReady: true };
      snapshots.set(ballotId, updated);
      return updated;
    },
    approveTerm: () => Promise.resolve({ status: "unavailable", snapshot: null }),
    acknowledgeClosed: () => Promise.resolve(),
  };
};
