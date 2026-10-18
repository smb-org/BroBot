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
  voterId?: string;
  onCastResult?: (ballotId: string, result: BallotCastResult) => void;
}

/** Simulates ballot mutations in memory while reading the running snapshot through read-only RPCs. */
export const createDryRunBallotAccess = (
  context: ModuleDryRunContext,
  options: DryRunBallotSimulationOptions = {},
): ModuleBallotAccess => {
  const snapshots = new Map<string, ModuleDryRunBallotSnapshot>();
  const snapshotReads = new Map<string, Promise<ModuleDryRunBallotSnapshot | null>>();
  const rules = new Map<string, BallotFinalizeRule | undefined>();
  for (const [ballotId, rule] of options.initialRules ?? []) rules.set(ballotId, rule);
  const expiresAt = new Map<string, number>();
  const voterChoices = new Map<string, Map<string, number | string>>();

  const snapshotFor = async (ballotId: string): Promise<ModuleDryRunBallotSnapshot | null> => {
    const projected = snapshots.get(ballotId);
    if (projected !== undefined) return projected;
    const pending = snapshotReads.get(ballotId);
    if (pending !== undefined) return pending;
    const readSnapshot = context.ballots?.readSnapshot;
    if (readSnapshot === undefined) throw new Error("Dry-run ballot snapshots are unavailable.");
    const read = readSnapshot(ballotId, options.voterId);
    snapshotReads.set(ballotId, read);
    const snapshot = await read;
    if (snapshot !== null) snapshots.set(ballotId, snapshot);
    return snapshot;
  };

  const castResult = (ballotId: string, result: BallotCastResult): BallotCastResult => {
    options.onCastResult?.(ballotId, result);
    return result;
  };

  const hasOpenBallotSnapshot = async (): Promise<boolean> => {
    if ([...snapshots.values()].some((snapshot) => snapshot.outcome === undefined &&
        snapshot.isActive !== false &&
        (snapshot.expiresAt ?? Number.POSITIVE_INFINITY) > Date.now())) return true;
    const readAvailability = context.ballots?.hasOpenBallotSnapshot;
    if (readAvailability === undefined) throw new Error("Dry-run ballot snapshots are unavailable.");
    return await readAvailability();
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
      if (await snapshotFor(ballotId) !== null) return { status: "busy", moduleId: "active" };
      if (await hasOpenBallotSnapshot()) return { status: "busy", moduleId: "active" };
      rules.set(ballotId, rule);
      expiresAt.set(ballotId, deadline);
      snapshots.set(ballotId, {
        counts: Array.from({ length: optionCount }, () => 0),
        revision: 0,
        expiresAt: deadline,
        isActive: true,
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
          snapshot.isActive === false ||
          (snapshot.expiresAt ?? expiresAt.get(ballotId) ?? Number.POSITIVE_INFINITY) <= Date.now()) {
        return castResult(ballotId, { status: "not_open", counts: [], revision: 0 });
      }
      if (snapshot.previousChoiceKnown === false) {
        context.markBallotChoiceUnresolved?.();
        return castResult(ballotId, { status: "not_open", ...snapshot });
      }
      const voters = voterMapFor(ballotId);
      const previous = voters.has(userId)
        ? voters.get(userId)
        : userId === options.voterId ? snapshot.previousChoice : undefined;
      if (castOptions?.onlyIfNew === true && previous !== undefined || previous === choice) {
        return castResult(ballotId, { status: "unchanged", ...snapshot });
      }
      const counts = [...snapshot.counts];
      if (typeof previous === "number" && previous >= 1 && previous <= counts.length) {
        counts[previous - 1] = Math.max(0, (counts[previous - 1] ?? 0) - 1);
      }
      counts[choice - 1] = (counts[choice - 1] ?? 0) + 1;
      const updated = { ...snapshot, counts, revision: snapshot.revision + 1 };
      voters.set(userId, choice);
      snapshots.set(ballotId, updated);
      return castResult(ballotId, { status: previous === undefined ? "counted" : "changed", ...updated });
    },
    castTerm: async (ballotId, userId, term, matchText = term): Promise<BallotCastResult> => {
      const snapshot = await snapshotFor(ballotId);
      if (snapshot === null || snapshot.outcome !== undefined || typeof matchText !== "string" ||
          Array.from(term).length > 25 || term.trim().length === 0 || Array.from(matchText).length > 500 ||
          snapshot.terms === undefined || snapshot.isActive === false ||
          (snapshot.expiresAt ?? expiresAt.get(ballotId) ?? Number.POSITIVE_INFINITY) <= Date.now()) {
        return castResult(ballotId, { status: "not_open", counts: [], revision: 0 });
      }
      const isBlockedFreeTextVote = options.isBlockedFreeTextVote;
      if (isBlockedFreeTextVote === undefined) throw new Error("Dry-run free-text vote predicate is unavailable.");
      const blockedTerms = snapshot.blockedTerms ?? [];
      const blocked = isBlockedFreeTextVote(term, blockedTerms) || isBlockedFreeTextVote(matchText, blockedTerms);
      if (blocked) return castResult(ballotId, { status: "blocked", ...snapshot });
      if (snapshot.previousChoiceKnown === false) {
        context.markBallotChoiceUnresolved?.();
        return castResult(ballotId, { status: "not_open", ...snapshot });
      }
      const voters = voterMapFor(ballotId);
      const previous = voters.has(userId)
        ? voters.get(userId)
        : userId === options.voterId ? snapshot.previousChoice : undefined;
      const terms = new Map((snapshot.terms ?? []).map((entry) => [entry.term, { ...entry }]));
      if (previous === term && terms.has(term)) return castResult(ballotId, { status: "unchanged", ...snapshot });
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
        return castResult(ballotId, { status: "overflow", ...updated });
      }
      if (existing === undefined) terms.set(term, {
        term,
        count: 1,
        approved: (snapshot.approvedTerms ?? []).includes(term),
      });
      else terms.set(term, { ...existing, count: existing.count + 1 });
      const updated = { ...snapshot, terms: [...terms.values()], revision: snapshot.revision + 1 };
      snapshots.set(ballotId, updated);
      voters.set(userId, term);
      return castResult(ballotId, { status: previous === undefined ? "counted" : "changed", ...updated });
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
      const expired = (snapshot.expiresAt ?? expiresAt.get(ballotId) ?? Number.POSITIVE_INFINITY) <= Date.now();
      return { ...snapshot, outcome: passed ? "passed" : expired ? "expired" : "open" };
    },
    setBlockedTerms: async (ballotId, blockedTerms) => {
      const snapshot = await snapshotFor(ballotId);
      if (snapshot === null || snapshot.outcome !== undefined || snapshot.terms === undefined ||
          snapshot.isActive === false || (snapshot.expiresAt ?? Number.POSITIVE_INFINITY) <= Date.now()) return null;
      const isBlockedFreeTextVote = options.isBlockedFreeTextVote;
      if (isBlockedFreeTextVote === undefined) throw new Error("Dry-run free-text vote predicate is unavailable.");
      const retainedTerms = snapshot.terms.filter(({ term }) => !isBlockedFreeTextVote(term, blockedTerms));
      const filterChanged = JSON.stringify(snapshot.blockedTerms ?? null) !== JSON.stringify([...blockedTerms]);
      const tallyChanged = retainedTerms.length !== snapshot.terms.length;
      for (const [userId, previous] of voterMapFor(ballotId)) {
        if (typeof previous === "string" && isBlockedFreeTextVote(previous, blockedTerms)) voterMapFor(ballotId).delete(userId);
      }
      const clearPinnedChoice = typeof snapshot.previousChoice === "string" &&
        isBlockedFreeTextVote(snapshot.previousChoice, blockedTerms);
      const pinnedSnapshot = { ...snapshot };
      if (clearPinnedChoice) delete pinnedSnapshot.previousChoice;
      const updated = {
        ...pinnedSnapshot,
        terms: retainedTerms,
        blockedTerms: [...blockedTerms],
        termFilterReady: true,
        revision: snapshot.revision + Number(filterChanged || tallyChanged),
      };
      snapshots.set(ballotId, updated);
      return updated;
    },
    approveTerm: async (ballotId, term) => {
      const snapshot = await snapshotFor(ballotId);
      if (snapshot === null || snapshot.outcome !== undefined || snapshot.terms === undefined ||
          snapshot.isActive === false || (snapshot.expiresAt ?? Number.POSITIVE_INFINITY) <= Date.now()) {
        return { status: "not_open", snapshot: null };
      }
      if (snapshot.blockedTerms === null || snapshot.blockedTerms === undefined) {
        return { status: "unavailable", snapshot };
      }
      const isBlockedFreeTextVote = options.isBlockedFreeTextVote;
      if (isBlockedFreeTextVote === undefined) throw new Error("Dry-run free-text vote predicate is unavailable.");
      if (isBlockedFreeTextVote(term, snapshot.blockedTerms)) return { status: "blocked", snapshot };
      const entry = snapshot.terms.find(({ term: existingTerm }) => existingTerm === term);
      if (entry === undefined) return { status: "not_open", snapshot };
      const approvedTerms = new Set(snapshot.approvedTerms ?? snapshot.terms.filter(({ approved }) => approved).map(({ term: approvedTerm }) => approvedTerm));
      const approvalsChanged = !approvedTerms.has(term);
      approvedTerms.add(term);
      const tallyChanged = !entry.approved;
      const updated = !approvalsChanged && !tallyChanged ? snapshot : {
        ...snapshot,
        terms: snapshot.terms.map((candidate) => candidate.term === term ? { ...candidate, approved: true } : candidate),
        approvedTerms: [...approvedTerms],
        revision: snapshot.revision + Number(tallyChanged),
      };
      if (updated !== snapshot) snapshots.set(ballotId, updated);
      return { status: "approved", snapshot: updated };
    },
    acknowledgeClosed: () => Promise.resolve(),
  };
};
