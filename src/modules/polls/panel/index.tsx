import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { connectedRefetchInterval, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import { Badge, Button, ConfirmDialog, Field, Icon, SegmentChoice, notify } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import {
  POLLS_ENTRY_MAXIMUM_COUNT,
  type PollsEntry,
  type PollsEntryInput,
  type PollsKind,
  type PollsRun,
  type PollsRunChoice,
} from "../contracts";
import { pollsPanelTexts } from "./locale";
import {
  cancelPollsRun,
  createPollsEntry,
  deletePollsEntry,
  dismissPollsRun,
  endPollsRun,
  loadPollsHistory,
  loadPollsState,
  lockPollsRun,
  reconcilePolls,
  resolvePollsRun,
  startPollsEntry,
  updatePollsEntry,
} from "./service";
import type { PollsPanelState } from "./service";
import { newDraftChoice } from "./draft-choice";
import EntryEditorDialog, { type PollsEntryDraft } from "./EntryEditorDialog";
import ResolveDialog from "./ResolveDialog";
import "./panel.css";

type PollsPanelLanguage = "de" | "en";
type EntryFilter = "all" | PollsKind;
type EditorState = { kind: "create"; initial: PollsEntryDraft } | { kind: "edit"; entry: PollsEntry };
type ConfirmState = { kind: "delete"; entry: PollsEntry } | { kind: "cancel"; run: PollsRun };

const EMPTY_STATE: PollsPanelState = { active: { poll: null, prediction: null }, open: [], entries: [] };

const isOpenRun = (run: PollsRun): boolean => run.status === "active" || run.status === "locked";

const entryToDraft = (entry: PollsEntry): PollsEntryDraft => ({
  kind: entry.kind,
  title: entry.title,
  choices: entry.choices.map((text) => newDraftChoice(text)),
  durationSeconds: entry.durationSeconds,
  channelPointsVotingEnabled: entry.channelPointsVotingEnabled,
  channelPointsPerVote: entry.channelPointsPerVote ?? "",
});

const newDraft = (kind: PollsKind = "poll"): PollsEntryDraft => ({
  kind,
  title: "",
  choices: [newDraftChoice(), newDraftChoice()],
  durationSeconds: kind === "poll" ? 60 : 120,
  channelPointsVotingEnabled: false,
  channelPointsPerVote: "",
});

const apiErrorMessage = (error: unknown, labels: typeof pollsPanelTexts.en): string => {
  if (!(error instanceof PanelApiError)) return labels.requestFailed;
  const code = error.code;
  if (code === "polls_not_eligible") return labels.notEligible;
  if (code === "polls_already_active") return labels.alreadyActive;
  if (code === "polls_not_connected") return labels.missingConnection;
  if (code === "polls_token_unavailable") return labels.tokenUnavailable;
  if (code === "polls_scope_missing") return labels.missingScope;
  if (code === "polls_revoked") return labels.revoked;
  if (code === "polls_refresh_failed") return labels.refreshFailed;
  if (code === "polls_rate_limited" || error.status === 429) return labels.rateLimited;
  if (code === "polls_network") return labels.network;
  if (code === "polls_unknown_status") return labels.twitchStatusUnknown;
  if (code === "polls_invalid_response") return labels.twitchInvalidResponse;
  if (code === "polls_entry_limit") return labels.entryLimit;
  if (code === "polls_entry_conflict") return labels.conflict;
  if (code === "polls_module_disabled") return labels.moduleDisabled;
  if (code === "polls_management_denied" || code === "polls_precondition_failed") return labels.managementDenied;
  if (code === "polls_run_not_found" || code === "polls_entry_not_found") return labels.runNotFound;
  if (code === "polls_not_open") return labels.notOpen;
  if (code === "polls_run_not_dismissible") return labels.notDismissible;
  if (code === "polls_invalid_choice") return labels.choiceInvalid;
  if (code === "polls_invalid_entry" || code === "polls_invalid_input") return labels.invalidEntry;
  return labels.requestFailed;
};

const refreshAfterWrite = async (
  refreshState: () => Promise<unknown>,
  refreshHistory: () => Promise<unknown>,
): Promise<void> => {
  await Promise.all([refreshState(), refreshHistory()]);
};

const formatCount = (value: number | null, language: PollsPanelLanguage): string =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US").format(value ?? 0);

const formatDate = (value: string, language: PollsPanelLanguage): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    dateStyle: "medium", timeStyle: "short",
  }).format(timestamp);
};

const countdown = (endsAt: string | null, now: number): string => {
  if (endsAt === null) return "—";
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.ceil((end - now) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
};

const choiceValue = (choice: PollsRunChoice, kind: PollsKind): number =>
  kind === "poll" ? choice.votes ?? 0 : choice.channelPoints ?? choice.users ?? 0;

const historyResult = (run: PollsRun, labels: typeof pollsPanelTexts.en, language: PollsPanelLanguage): string => {
  if (run.kind === "prediction" && run.status === "resolved") {
    const winner = run.choices.find(({ id }) => id === run.winningChoiceId);
    return winner === undefined ? labels.resultUnknown : labels.resultResolved(winner.title);
  }
  if (run.kind === "prediction" && run.status === "canceled") return labels.resultCanceled;
  if (run.status === "unknown") return labels.resultUnknown;
  if (run.kind === "poll") {
    const highest = Math.max(0, ...run.choices.map(({ votes }) => votes ?? 0));
    const winners = run.choices.filter(({ votes }) => (votes ?? 0) === highest && highest > 0).map(({ title }) => title);
    if (winners.length > 0) return `${winners.join(", ")} · ${formatCount(highest, language)} ${labels.votes}`;
  }
  if (run.status === "completed") return labels.statusCompleted;
  if (run.status === "terminated") return labels.statusTerminated;
  if (run.status === "archived") return labels.statusArchived;
  if (run.status === "active") return labels.statusActive;
  if (run.status === "locked") return labels.statusLocked;
  return labels.resultUnknown;
};

function RunSlot({
  kind,
  run,
  loading,
  language,
  labels,
  canOperate,
  pending,
  onEnd,
  onLock,
  onResolve,
  onCancel,
  now,
}: {
  kind: PollsKind;
  run: PollsRun | null;
  loading: boolean;
  language: PollsPanelLanguage;
  labels: typeof pollsPanelTexts.en;
  canOperate: boolean;
  pending: boolean;
  onEnd: () => void;
  onLock: () => void;
  onResolve: () => void;
  onCancel: () => void;
  now: number;
}): ReactElement {
  const heading = kind === "poll" ? labels.poll : labels.prediction;
  if (run === null) return <article className="polls-run-slot" aria-label={heading}>
    <div className="polls-run-slot__heading"><h3>{heading}</h3></div>
    <p className="polls-run-slot__empty">{loading ? labels.loading : kind === "poll" ? labels.noPoll : labels.noPrediction}</p>
  </article>;

  const maximum = Math.max(1, ...run.choices.map((choice) => choiceValue(choice, kind)));
  return <article className="polls-run-slot polls-run-slot--active" aria-label={heading}>
    <div className="polls-run-slot__heading">
      <h3>{heading}</h3>
      <Badge tone="green">{labels.activeStatus}</Badge>
      <time className="polls-run-slot__countdown" dateTime={run.endsAt ?? undefined} aria-label={`${labels.remaining}: ${countdown(run.endsAt, now)}`}>
        <Icon name="clock-hour-4" />{countdown(run.endsAt, now)}
      </time>
    </div>
    <strong className="polls-run-slot__title" title={run.title}>{run.title}</strong>
    <div className="polls-run-slot__choices">
      {run.choices.map((choice) => {
        const score = choiceValue(choice, kind);
        const width = Math.round(score / maximum * 100);
        return <div className="polls-run-choice" key={choice.id}>
          <span className="polls-run-choice__title" title={choice.title}>{choice.title}</span>
          <span className="polls-run-choice__track" aria-hidden="true"><span style={{ width: `${String(width)}%` }} /></span>
          <span className="polls-run-choice__value mono">
            {kind === "poll"
              ? `${formatCount(choice.votes, language)} ${labels.votes}`
              : `${formatCount(choice.users, language)} ${labels.users} · ${formatCount(choice.channelPoints, language)} ${labels.points}`}
          </span>
        </div>;
      })}
    </div>
    {!canOperate ? null : <div className="polls-run-slot__actions">
      {kind === "poll"
        ? <Button size="compact" disabled={pending} onClick={onEnd}>{labels.end}</Button>
        : <>
          <Button size="compact" variant="primary" disabled={pending} onClick={onLock}>{labels.lock}</Button>
          <Button size="compact" disabled={pending} onClick={onResolve}>{labels.resolve}</Button>
          <Button size="compact" disabled={pending} onClick={onCancel}>{labels.cancel}</Button>
        </>}
    </div>}
  </article>;
}

function HistoryRow({ run, labels, language }: {
  run: PollsRun;
  labels: typeof pollsPanelTexts.en;
  language: PollsPanelLanguage;
}): ReactElement {
  return <article className="polls-history-row">
    <span className="polls-history-row__kind">{run.kind === "poll" ? labels.poll : labels.prediction}</span>
    <strong className="polls-history-row__title" title={run.title}>{run.title}</strong>
    <span className="polls-history-row__result" title={historyResult(run, labels, language)}>{historyResult(run, labels, language)}</span>
    <time className="polls-history-row__time" dateTime={run.startedAt}>{formatDate(run.startedAt, language)}</time>
    <span className="polls-history-row__source">{labels.source}: {run.source === "brobot" ? labels.sourceBot : labels.sourceTwitch}</span>
  </article>;
}

export default function PollsPanel({ channelId, language = "de", canOperate = true }: ModulePanelProperties): ReactElement {
  const activeLanguage: PollsPanelLanguage = language;
  const labels = pollsPanelTexts[activeLanguage];
  const [filter, setFilter] = useState<EntryFilter>("all");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [resolveRun, setResolveRun] = useState<PollsRun | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [reconcilePending, setReconcilePending] = useState(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [historyCursors, setHistoryCursors] = useState<(string | null)[]>([null]);
  const [now, setNow] = useState(() => Date.now());
  const reconcileAttemptedFor = useRef<string | null>(null);
  const reconcilePendingRef = useRef(false);
  const isOperator = canOperate;

  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const refetchInterval = connectedRefetchInterval(realtimeStatus === "connected", 15_000);
  const stateQuery = useModuleQuery(channelId, "polls", "data", (signal) => loadPollsState(channelId, signal), { refetchInterval });
  const cursor = historyCursors[historyCursors.length - 1] ?? null;
  const historyPart = cursor === null ? "history:first" : `history:${cursor}`;
  const historyQuery = useModuleQuery(channelId, "polls", historyPart,
    (signal) => loadPollsHistory(channelId, cursor, signal), { refetchInterval });
  const data = stateQuery.data ?? EMPTY_STATE;
  const historyRuns = historyQuery.data?.runs ?? [];
  const hasTimedRun = data.active.poll !== null || data.active.prediction !== null;

  const refetchState = stateQuery.refetch;
  const refetchHistory = historyQuery.refetch;
  const refreshData = useCallback(async (): Promise<void> => {
    await refreshAfterWrite(() => refetchState(), () => refetchHistory());
  }, [refetchHistory, refetchState]);

  useEffect(() => {
    if (!hasTimedRun) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasTimedRun]);

  useEffect(() => {
    if (stateQuery.data === undefined || !stateQuery.isFetched || reconcileAttemptedFor.current === channelId) return;
    reconcileAttemptedFor.current = channelId;
    const hasOpenState = stateQuery.data.open.length > 0 || stateQuery.data.active.poll !== null || stateQuery.data.active.prediction !== null;
    if (!isOperator || !hasOpenState) return;
    reconcilePendingRef.current = true;
    queueMicrotask(() => setReconcilePending(true));
    void reconcilePolls(channelId, false).then(async () => {
      await refreshData();
    }).catch((error: unknown) => {
      const message = apiErrorMessage(error, labels);
      setFeedback(message);
      notify({ tone: "error", message });
    }).finally(() => {
      reconcilePendingRef.current = false;
      setReconcilePending(false);
    });
  }, [channelId, isOperator, labels, refreshData, stateQuery.data, stateQuery.isFetched]);

  const blockingRun = (kind: PollsKind): PollsRun | null => {
    const active = data.active[kind];
    if (active !== null && isOpenRun(active)) return active;
    if (kind === "prediction") {
      return data.open.find((run) => run.kind === kind && run.status === "locked") ?? null;
    }
    return null;
  };

  const visibleEntries = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return data.entries.filter((entry) => (filter === "all" || entry.kind === filter) &&
      (term.length === 0 || entry.title.toLocaleLowerCase().includes(term)));
  }, [data.entries, filter, search]);

  const openRuns = useMemo(() => [...data.open]
    .filter((run) => run.dismissedAt === null && (run.status === "unknown" || (run.kind === "prediction" && run.status === "locked")))
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)), [data.open]);

  const feedbackForError = (error: unknown): string => apiErrorMessage(error, labels);

  const showSuccess = async (message: string): Promise<void> => {
    setFeedback(message);
    notify({ tone: "success", message });
    await refreshData();
  };

  const startEntry = async (entry: PollsEntry): Promise<void> => {
    if (!isOperator || pendingEntryId !== null || blockingRun(entry.kind) !== null) return;
    setPendingEntryId(entry.id);
    setFeedback(null);
    try {
      await startPollsEntry(channelId, entry.id);
      await showSuccess(labels.successStarted);
    } catch (error) {
      const message = feedbackForError(error);
      setFeedback(message);
      notify({ tone: "error", message });
      if (error instanceof PanelApiError && error.code === "polls_already_active") await refreshData();
    } finally {
      setPendingEntryId(null);
    }
  };

  const runAction = async (
    run: PollsRun,
    action: () => Promise<PollsRun>,
    successMessage: string,
  ): Promise<void> => {
    if (!isOperator || pendingRunId !== null) return;
    setPendingRunId(run.id);
    setFeedback(null);
    try {
      await action();
      await showSuccess(successMessage);
    } catch (error) {
      const message = feedbackForError(error);
      setFeedback(message);
      notify({ tone: "error", message });
      if (error instanceof PanelApiError && error.code === "polls_not_open") await refreshData();
    } finally {
      setPendingRunId(null);
    }
  };

  const confirmAction = async (): Promise<void> => {
    if (confirm === null || confirmPending || !isOperator) return;
    setConfirmPending(true);
    setConfirmError(undefined);
    try {
      if (confirm.kind === "delete") {
        await deletePollsEntry(channelId, confirm.entry.id);
        setConfirm(null);
        await showSuccess(labels.successDeleted);
      } else {
        await cancelPollsRun(channelId, confirm.run.id);
        setConfirm(null);
        await showSuccess(labels.successCanceled);
      }
    } catch (error) {
      setConfirmError(feedbackForError(error));
    } finally {
      setConfirmPending(false);
    }
  };

  const saveEntry = async (entryId: string | null, revision: number | null, input: PollsEntryInput): Promise<void> => {
    if (!isOperator) return;
    if (entryId === null || revision === null) await createPollsEntry(channelId, input);
    else await updatePollsEntry(channelId, entryId, revision, input);
    await showSuccess(labels.successSaved);
  };

  const deleteTitle = confirm?.kind === "delete" ? labels.deleteDescription(confirm.entry.title) : labels.cancelDescription;
  const currentCursorIndex = historyCursors.length - 1;

  return <section className="module-stack polls-panel" aria-label={labels.page}>
    <div className="polls-panel__toolbar">
      {isOperator ? <Button variant="neutral" icon="reload" disabled={pendingRunId !== null || stateQuery.isFetching || reconcilePending} onClick={() => {
        if (reconcilePendingRef.current) return;
        reconcilePendingRef.current = true;
        setReconcilePending(true);
        setFeedback(null);
        void reconcilePolls(channelId, true).then(async () => {
          await refreshData();
          setFeedback(labels.successReconciled);
          notify({ tone: "success", message: labels.successReconciled });
        }).catch((error: unknown) => {
          const message = feedbackForError(error);
          setFeedback(message);
          notify({ tone: "error", message });
        }).finally(() => {
          reconcilePendingRef.current = false;
          setReconcilePending(false);
        });
      }}>{labels.refreshFromTwitch}</Button> : <span />}
      <div className="polls-panel__feedback" role={stateQuery.isError ? "alert" : "status"} aria-live="polite">
        {feedback ?? (stateQuery.isError ? labels.loadFailed : stateQuery.data === undefined ? labels.loading : "")}
      </div>
      {stateQuery.isError ? <Button size="compact" onClick={() => { void refreshData(); }}>{labels.retry}</Button> : <span className="polls-panel__toolbar-spacer" />}
    </div>

    <section className="polls-section polls-running" aria-label={labels.runningNow}>
      <div className="polls-section__heading"><h2>{labels.runningNow}</h2></div>
      <div className="polls-running__slots">
        <RunSlot
          kind="poll" run={data.active.poll} loading={stateQuery.data === undefined} language={activeLanguage} labels={labels} canOperate={isOperator}
          pending={pendingRunId !== null} now={now}
          onEnd={() => { if (data.active.poll !== null) void runAction(data.active.poll, () => endPollsRun(channelId, data.active.poll?.id ?? ""), labels.successEnded); }}
          onLock={() => undefined} onResolve={() => undefined} onCancel={() => undefined}
        />
        <RunSlot
          kind="prediction" run={data.active.prediction} loading={stateQuery.data === undefined} language={activeLanguage} labels={labels} canOperate={isOperator}
          pending={pendingRunId !== null} now={now}
          onEnd={() => undefined}
          onLock={() => { if (data.active.prediction !== null) void runAction(data.active.prediction, () => lockPollsRun(channelId, data.active.prediction?.id ?? ""), labels.successLocked); }}
          onResolve={() => { if (data.active.prediction !== null) setResolveRun(data.active.prediction); }}
          onCancel={() => { if (data.active.prediction !== null) { setConfirm({ kind: "cancel", run: data.active.prediction }); setConfirmError(undefined); } }}
        />
      </div>
    </section>

    <section className="polls-section polls-open" aria-label={labels.openPredictions}>
      <div className="polls-section__heading"><h2>{labels.openPredictions}</h2></div>
      <div className="polls-open__list">
        {openRuns.length === 0 ? <p className="polls-section__empty">{stateQuery.data === undefined ? labels.loading : labels.noOpenPredictions}</p> :
          openRuns.map((run) => run.status === "unknown" ? <article className="polls-open-row polls-open-row--unknown" key={run.id}>
            <span className="polls-open-row__kind">{run.kind === "poll" ? labels.poll : labels.prediction}</span>
            <strong className="polls-open-row__title" title={run.title}>{run.title}</strong>
            <span className="polls-open-row__status">{labels.checkOnTwitch}</span>
            {!isOperator ? null : <Button size="compact" variant="neutral" disabled={pendingRunId !== null} onClick={() => {
              void runAction(run, async () => {
                const dismissed = await dismissPollsRun(channelId, run.id);
                return dismissed;
              }, labels.successDismissed);
            }}>{labels.dismiss}</Button>}
          </article> : <article className="polls-open-row" key={run.id}>
            <span className="polls-open-row__kind">{labels.prediction}</span>
            <strong className="polls-open-row__title" title={run.title}>{run.title}</strong>
            <span className="polls-open-row__refund">{labels.refundDeadline}: {run.refundDeadline === null ? "—" : formatDate(run.refundDeadline, activeLanguage)}</span>
            {!isOperator ? null : <div className="polls-open-row__actions">
              <Button size="compact" variant="primary" disabled={pendingRunId !== null} onClick={() => { setResolveRun(run); }}>{labels.resolve}</Button>
              <Button size="compact" disabled={pendingRunId !== null} onClick={() => { setConfirm({ kind: "cancel", run }); setConfirmError(undefined); }}>{labels.cancel}</Button>
            </div>}
          </article>)}
      </div>
    </section>

    <section className="polls-section polls-entries" aria-label={labels.preparedEntries}>
      <div className="polls-section__heading"><h2>{labels.preparedEntries}</h2></div>
      <div className="polls-entries__toolbar">
        <Field variant="search" label={labels.search} clearLabel={labels.clearSearch} value={search} onChange={setSearch} placeholder={labels.searchPlaceholder} />
        <SegmentChoice<EntryFilter>
          label={labels.filter}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: labels.allKinds },
            { value: "poll", label: labels.polls },
            { value: "prediction", label: labels.predictions },
          ]}
          size="compact"
        />
        {isOperator ? <Button variant="primary" icon="add" disabled={stateQuery.data === undefined || data.entries.length >= POLLS_ENTRY_MAXIMUM_COUNT} {...(data.entries.length >= POLLS_ENTRY_MAXIMUM_COUNT ? { title: labels.entryLimit } : {})} onClick={() => setEditor({ kind: "create", initial: newDraft() })}>{labels.newEntry}</Button> : null}
      </div>
      {data.entries.length >= POLLS_ENTRY_MAXIMUM_COUNT ? <p className="polls-entries__limit" role="note">{labels.entryLimit}</p> : <span className="polls-entries__limit-spacer" />}
      <div className="polls-entries__list">
        {visibleEntries.length === 0 ? <p className="polls-section__empty polls-entries__empty">{stateQuery.data === undefined ? labels.loading : labels.noEntries}</p> :
          visibleEntries.map((entry) => {
            const blocked = blockingRun(entry.kind);
            const reason = blocked === null ? undefined : blocked.status === "locked"
              ? labels.runningLockReason
              : entry.kind === "poll" ? labels.runningPollReason : labels.runningPredictionReason;
            const startDisabled = pendingEntryId !== null || blocked !== null;
            return <article className="polls-entry-row" aria-label={entry.title} key={entry.id}>
              <div className="polls-entry-row__identity">
                <span className="polls-entry-row__kind">{entry.kind === "poll" ? labels.poll : labels.prediction}</span>
                <strong className="polls-entry-row__title" title={entry.title}>{entry.title}</strong>
                <span className="polls-entry-row__meta">{labels.choiceCount(entry.choices.length)} · {String(entry.durationSeconds)} {labels.seconds}</span>
              </div>
              {isOperator ? <div className="polls-entry-row__controls">
                <div className="polls-entry-row__actions">
                <Button variant="primary" size="compact" disabled={startDisabled} {...(reason === undefined ? {} : { title: reason })} onClick={() => { void startEntry(entry); }}>{labels.start}</Button>
                <Button size="compact" icon="edit" disabled={pendingEntryId !== null} onClick={() => setEditor({ kind: "edit", entry })}>{labels.edit}</Button>
                <Button size="compact" icon="copy" disabled={pendingEntryId !== null} onClick={() => setEditor({ kind: "create", initial: entryToDraft(entry) })}>{labels.duplicate}</Button>
                <Button size="compact" danger="subtle" icon="remove" disabled={pendingEntryId !== null} onClick={() => { setConfirm({ kind: "delete", entry }); setConfirmError(undefined); }}>{labels.delete}</Button>
                </div>
                <span className="polls-entry-row__reason" role="note">{reason ?? " "}</span>
              </div> : null}
            </article>;
          })}
      </div>
    </section>

    <section className="polls-section polls-history" aria-label={labels.history}>
      <div className="polls-section__heading polls-history__heading">
        <h2>{labels.history}</h2>
        <div className="polls-history__pagination" aria-label={labels.history}>
          {historyQuery.isError ? <Button size="compact" onClick={() => { void historyQuery.refetch(); }}>{labels.retry}</Button> : null}
          <Button size="compact" icon="chevron-left" iconOnly ariaLabel={labels.previousPage} disabled={currentCursorIndex === 0} onClick={() => {
            setHistoryCursors((current) => current.length <= 1 ? current : current.slice(0, -1));
          }} />
          <span>{String(currentCursorIndex + 1)}</span>
          <Button size="compact" icon="chevron-right" iconOnly ariaLabel={labels.nextPage} disabled={historyQuery.isError || historyQuery.isFetching || historyQuery.data?.nextCursor == null} onClick={() => {
            const nextCursor = historyQuery.data?.nextCursor;
            if (nextCursor !== undefined && nextCursor !== null) setHistoryCursors((current) => [...current, nextCursor]);
          }} />
        </div>
      </div>
      <div className="polls-history__list" aria-busy={historyQuery.isFetching}>
        {historyQuery.isError ? <p className="polls-section__empty" role="alert">{labels.loadFailed}</p>
          : historyRuns.length === 0 ? <p className="polls-section__empty">{historyQuery.data === undefined ? labels.loading : labels.historyEmpty}</p>
          : historyRuns.map((run) => <HistoryRow key={run.id} run={run} labels={labels} language={activeLanguage} />)}
      </div>
    </section>

    {editor === null ? null : <EntryEditorDialog
      key={editor.kind === "edit" ? `edit:${editor.entry.id}:${String(editor.entry.revision)}` : `create:${editor.initial.kind}:${editor.initial.title}`}
      language={activeLanguage}
      canOperate={isOperator}
      entry={editor.kind === "edit" ? editor.entry : null}
      initial={editor.kind === "create" ? editor.initial : entryToDraft(editor.entry)}
      onClose={() => setEditor(null)}
      onSave={async (input) => {
        await saveEntry(editor.kind === "edit" ? editor.entry.id : null,
          editor.kind === "edit" ? editor.entry.revision : null, input);
      }}
    />}

    {resolveRun === null ? null : <ResolveDialog
      key={resolveRun.id}
      channelId={channelId}
      run={resolveRun}
      language={activeLanguage}
      canOperate={isOperator}
      onClose={() => setResolveRun(null)}
      onResolve={async (choiceId) => {
        await resolvePollsRun(channelId, resolveRun.id, choiceId);
        setResolveRun(null);
        await showSuccess(labels.successResolved);
      }}
    />}

    <ConfirmDialog
      opened={confirm !== null}
      title={confirm?.kind === "delete" ? labels.deleteTitle : labels.cancelDialog}
      description={confirm?.kind === "delete" ? deleteTitle : labels.cancelDescription}
      confirmLabel={confirm?.kind === "delete" ? labels.confirmDelete : labels.confirmCancel}
      cancelLabel={labels.discard}
      danger={confirm?.kind === "delete"}
      pending={confirmPending}
      {...(confirmError === undefined ? {} : { error: confirmError })}
      onCancel={() => { if (!confirmPending) setConfirm(null); }}
      onConfirm={() => { void confirmAction(); }}
    />
  </section>;
}
