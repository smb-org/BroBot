import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import "./panel.css";

import { refetchModuleQueryData, runModuleQueryWrite, useChannelSettings, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { dashboardCommonTexts } from "../../../dashboard/locale";
import {
  ActionMenu,
  ChatTargetField,
  CollectionPage,
  ConfirmDialog,
  EmptyState,
  Field,
  ListToolbar,
  LoadState,
  LoadStateLines,
  PageHeader,
  RuleNote,
  Section,
  Select,
  SwitchRow,
  SwitchSection,
  TemplateTextField,
  UnitInput,
  notify,
  registerDashboardNavigationGuard,
  useDraftGuard,
  useTemplatePreview,
} from "../../../dashboard/ui";
import { formatRelativeTime } from "../../../dashboard/ui/format-relative-time";
import { formatTimerRunLabel } from "./format-timer-run-label";
import { Switch as SwitchPrimitive } from "../../../dashboard/ui/primitives/switch";
import { type ModulePanelProperties } from "../../contract";
import { TIMER_MAXIMUM_COUNT, type Timer, type TimerTrigger } from "../contracts";
import { inputFromDraft, type TimerDraft } from "./draft";
import { timersTexts } from "./locale";
import { nextRunLabel, triggerDetail } from "./summary";
import {
  createTimer,
  deleteTimer,
  loadTimersPanel,
  previewTimerText,
  setTimerEnabled,
  timerErrorCode,
  updateTimer,
  type TimersPanelData,
} from "./service";

type TriggerType = TimerTrigger["type"];

interface TimerIntervalDraft {
  minutes: number | "";
  minimumMessages: number | "";
}

const emptyIntervalDraft = (): TimerIntervalDraft => ({ minutes: 30, minimumMessages: "" });

const emptyDraft = (sources: TimersPanelData["sources"]): TimerDraft => ({
  name: "",
  messageText: "",
  chatTarget: "source_only",
  type: "interval",
  live: emptyIntervalDraft(),
  offline: null,
  minutes: 30,
  time: "12:00",
  weekdays: [],
  alsoOffline: false,
  sourceId: sources[0]?.id ?? "",
});

const draftFromTimer = (timer: Timer): TimerDraft => {
  const trigger = timer.trigger;
  if (trigger.type === "interval") return {
    ...emptyDraft([]), name: timer.name, messageText: timer.messageText, chatTarget: timer.chatTarget, type: trigger.type,
    live: trigger.live === undefined ? null : { minutes: trigger.live.minutes, minimumMessages: trigger.live.minimumMessages ?? "" },
    offline: trigger.offline === undefined ? null : { minutes: trigger.offline.minutes, minimumMessages: trigger.offline.minimumMessages ?? "" },
  };
  if (trigger.type === "stream_start") return {
    ...emptyDraft([]), name: timer.name, messageText: timer.messageText, chatTarget: timer.chatTarget, type: trigger.type, minutes: trigger.minutes,
  };
  if (trigger.type === "time_of_day") return {
    ...emptyDraft([]), name: timer.name, messageText: timer.messageText, chatTarget: timer.chatTarget, type: trigger.type,
    time: trigger.time, weekdays: [...trigger.weekdays], alsoOffline: trigger.alsoOffline,
  };
  return {
    ...emptyDraft([]), name: timer.name, messageText: timer.messageText, chatTarget: timer.chatTarget, type: trigger.type,
    minutes: trigger.minutes, sourceId: trigger.sourceId,
  };
};

const cloneDraft = (draft: TimerDraft): TimerDraft => ({
  ...draft,
  weekdays: [...draft.weekdays],
  live: draft.live === null ? null : { ...draft.live },
  offline: draft.offline === null ? null : { ...draft.offline },
});

const timersPanelDataFrom = (value: unknown): TimersPanelData => {
  if (typeof value === "object" && value !== null && "timers" in value && "sources" in value && "variables" in value &&
      Array.isArray(value.timers) && Array.isArray(value.sources) && Array.isArray(value.variables)) {
    return value as TimersPanelData;
  }
  return { timers: [], sources: [], variables: [] };
};

const withTimer = (current: unknown, timer: Timer): TimersPanelData => {
  const data = timersPanelDataFrom(current);
  const found = data.timers.some((candidate) => candidate.id === timer.id);
  const timers = found
    ? data.timers.map((candidate) => candidate.id === timer.id ? timer : candidate)
    : [...data.timers, timer];
  return { ...data, timers };
};

const withoutTimer = (current: unknown, timerId: string): TimersPanelData => {
  const data = timersPanelDataFrom(current);
  return { ...data, timers: data.timers.filter((timer) => timer.id !== timerId) };
};

const requireBaselineRevision = (revision: number | null): number => {
  if (revision === null) throw new Error("An existing timer requires its opening revision.");
  return revision;
};

const triggerTitle = (type: TriggerType, labels: ReturnType<typeof timersTexts>): string => {
  if (type === "interval") return labels.interval;
  if (type === "stream_start") return labels.streamStart;
  if (type === "time_of_day") return labels.timeOfDay;
  return labels.beforeEvent;
};

export default function TimersPanel(properties: ModulePanelProperties): ReactElement {
  return <TimersPanelContent key={properties.channelId} {...properties} />;
}

function TimersPanelContent({ channelId, language, canManage = true, canOperate = true }: ModulePanelProperties): ReactElement {
  const labels = timersTexts(language);
  const common = dashboardCommonTexts(language);
  const channelSettings = useChannelSettings(channelId);
  const timeZone = channelSettings.data?.timeZone ?? "UTC";
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery(channelId, "timers", "panel", (signal) => loadTimersPanel(channelId, signal));
  const data = query.data;
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TimerDraft | null>(null);
  const [baselineDraft, setBaselineDraft] = useState<TimerDraft | null>(null);
  const [editing, setEditing] = useState<Timer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busyTimerId, setBusyTimerId] = useState<string | null>(null);
  const editorPending = pending || busyTimerId !== null;
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [serverConflict, setServerConflict] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Timer | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const editorSwitch = useRef(0);
  const initialSelectionDone = useRef(false);
  const dirtyRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  const dirty = draft !== null && (editing === null || (baselineDraft !== null && JSON.stringify(draft) !== JSON.stringify(baselineDraft)));
  const input = draft === null ? null : inputFromDraft(draft);
  const previewMessage = draft?.messageText ?? "";
  const preview = useTemplatePreview({
    text: previewMessage,
    refreshKey: query.dataUpdatedAt,
    enabled: draft !== null && previewMessage.trim().length > 0,
    render: () => previewTimerText(channelId, previewMessage),
  });
  const previewText = preview.value ?? previewMessage;
  const previewBusy = preview.pending;
  const sourceOptions = useMemo(() => (data?.sources ?? []).map((source) => ({
    value: source.id,
    label: source.label[language ?? "de"],
  })), [data?.sources, language]);
  const visibleTimers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(language ?? "de");
    return (data?.timers ?? []).filter((timer) => needle.length === 0 ||
      `${timer.name} ${timer.messageText}`.toLocaleLowerCase(language ?? "de").includes(needle));
  }, [data?.timers, language, search]);
  const selectedTimer = editing === null ? undefined : data?.timers.find((timer) => timer.id === editing.id) ?? editing;
  const inheritedTargetLabel = channelSettings.data?.defaultChatTarget === "all_chats" ? labels.chatTargetLabels.all_chats
    : channelSettings.data?.defaultChatTarget === "source_only" ? labels.chatTargetLabels.source_only : labels.automatic;
  const targetLabel = (target: Timer["chatTarget"]): string => target === null ? labels.chatTargetInherited(inheritedTargetLabel)
    : target === "all_chats" ? labels.chatTargetLabels.all_chats : labels.chatTargetLabels.source_only;

  const closeEditorNow = (): void => {
    editorSwitch.current += 1;
    dirtyRef.current = false;
    setSelectedId(null);
    setDraft(null);
    setBaselineDraft(null);
    setEditing(null);
    setMobileDetailOpen(false);
    setDeleteTarget(null);
    setDeleteError(null);
    setError(null);
    setAttemptedSave(false);
    setServerConflict(false);
  };

  const openCreateNow = (): void => {
    editorSwitch.current += 1;
    dirtyRef.current = true;
    const next = emptyDraft(data?.sources ?? []);
    setSelectedId("__new__");
    setDraft(next);
    setBaselineDraft(null);
    setEditing(null);
    setMobileDetailOpen(true);
    setError(null);
    setAttemptedSave(false);
    setServerConflict(false);
  };

  const selectTimerNow = (timer: Timer): void => {
    editorSwitch.current += 1;
    dirtyRef.current = false;
    const next = draftFromTimer(timer);
    setSelectedId(timer.id);
    setDraft(cloneDraft(next));
    setBaselineDraft(cloneDraft(next));
    setEditing(timer);
    setMobileDetailOpen(true);
    setError(null);
    setAttemptedSave(false);
    setServerConflict(false);
  };

  const discardDraft = (): void => {
    if (editing === null) {
      closeEditorNow();
      return;
    }
    const next = draftFromTimer(editing);
    dirtyRef.current = false;
    setDraft(cloneDraft(next));
    setBaselineDraft(cloneDraft(next));
    setError(null);
    setAttemptedSave(false);
    setServerConflict(false);
  };

  const saveDraft = async (): Promise<string | null> => {
    if (editorPending) return null;
    setAttemptedSave(true);
    setError(null);
    if (draft === null || input === null || !canManage) {
      setError(labels.saveError);
      return labels.saveError;
    }
    setPending(true);
    const startedSwitch = editorSwitch.current;
    try {
      const saved = await runModuleQueryWrite(queryClient, channelId, "timers", "panel", (revision) =>
        editing === null ? createTimer(channelId, input) : updateTimer(channelId, editing.id, input, requireBaselineRevision(revision)), {
        baselineRevision: editing?.revision ?? null,
        updateCache: (current, timer) => withTimer(current, timer),
      });
      if (editorSwitch.current !== startedSwitch) return null;
      const next = draftFromTimer(saved);
      dirtyRef.current = false;
      setSelectedId(saved.id);
      setEditing(saved);
      setDraft(cloneDraft(next));
      setBaselineDraft(cloneDraft(next));
      setError(null);
      setAttemptedSave(false);
      setServerConflict(false);
      return null;
    } catch (failure: unknown) {
      if (editorSwitch.current !== startedSwitch) return null;
      const code = timerErrorCode(failure);
      const message = code === "timer_text_input_dependent" ? labels.inputDependentText
        : code === "timer_text_block_missing" ? labels.missingTextBlock
          : code === "timer_limit_reached" ? labels.limitReached
            : code === "timer_conflict" ? labels.conflict : labels.saveError;
      setError(message);
      if (code === "timer_conflict") setServerConflict(true);
      return message;
    } finally {
      setPending(false);
    }
  };

  const draftGuard = useDraftGuard(dirty, saveDraft, discardDraft);
  const guardSwitch = draftGuard.guardSwitch;
  useEffect(() => registerDashboardNavigationGuard((proceed, cancel) => {
    if (editorPending) {
      cancel();
      return;
    }
    guardSwitch(proceed, cancel);
  }), [editorPending, guardSwitch]);

  const openCreate = (): void => {
    if (editorPending) return;
    guardSwitch(() => { openCreateNow(); });
  };
  const selectTimer = (timer: Timer): void => {
    if (editorPending) return;
    if (timer.id === selectedId) {
      setMobileDetailOpen(true);
      return;
    }
    guardSwitch(() => { selectTimerNow(timer); });
  };
  const closeEditor = (): void => { if (!editorPending) guardSwitch(closeEditorNow); };

  const patchDraft = (change: Partial<TimerDraft>): void => {
    const next = draft === null ? null : { ...draft, ...change };
    dirtyRef.current = next !== null && (editing === null || baselineDraft === null || JSON.stringify(next) !== JSON.stringify(baselineDraft));
    setDraft(next);
    setError(null);
  };

  useEffect(() => {
    if (data === undefined || initialSelectionDone.current) return;
    initialSelectionDone.current = true;
    const preparedDraft = window.sessionStorage.getItem("brobot.timer-draft-message");
    if (preparedDraft !== null) {
      window.sessionStorage.removeItem("brobot.timer-draft-message");
      let prepared: unknown;
      try { prepared = JSON.parse(preparedDraft) as unknown; } catch { prepared = null; }
      if (typeof prepared === "object" && prepared !== null && !Array.isArray(prepared) &&
          "name" in prepared && typeof prepared.name === "string" && "messageText" in prepared && typeof prepared.messageText === "string") {
        const next = { ...emptyDraft(data.sources), name: prepared.name, messageText: prepared.messageText };
        const startedSwitch = editorSwitch.current;
        const timer = window.setTimeout(() => {
          if (editorSwitch.current !== startedSwitch) return;
          editorSwitch.current += 1;
          dirtyRef.current = true;
          setSelectedId("__new__");
          setDraft(next);
          setBaselineDraft(null);
          setEditing(null);
          setMobileDetailOpen(true);
          setError(null);
          setAttemptedSave(false);
          setServerConflict(false);
        });
        return () => { window.clearTimeout(timer); };
      }
    }
    const first = data.timers[0];
    if (first !== undefined && selectedId === null && draft === null) {
      const startedSwitch = editorSwitch.current;
      const timer = window.setTimeout(() => {
        if (editorSwitch.current !== startedSwitch) return;
        const next = draftFromTimer(first);
        dirtyRef.current = false;
        setSelectedId(first.id);
        setEditing(first);
        setDraft(cloneDraft(next));
        setBaselineDraft(cloneDraft(next));
      });
      return () => { window.clearTimeout(timer); };
    }
  }, [data, draft, selectedId]);

  useEffect(() => {
    if (data === undefined || editing === null) return;
    const startedSwitch = editorSwitch.current;
    const timer = window.setTimeout(() => {
      if (editorSwitch.current !== startedSwitch) return;
      const latest = data.timers.find((timer) => timer.id === editing.id);
      if (latest === undefined) {
        if (dirtyRef.current) setServerConflict(true);
        else closeEditorNow();
        return;
      }
      if (latest.revision === editing.revision) return;
      if (dirtyRef.current) {
        setServerConflict(true);
        return;
      }
      const next = draftFromTimer(latest);
      setEditing(latest);
      setDraft(cloneDraft(next));
      setBaselineDraft(cloneDraft(next));
      setServerConflict(false);
    });
    return () => { window.clearTimeout(timer); };
  }, [data, dirty, editing]);

  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 30_000);
    return () => { window.clearInterval(timer); };
  }, []);

  const toggle = async (timer: Timer, enabled: boolean): Promise<void> => {
    if (pending || deleteTarget !== null || busyTimerId !== null || dirty) return;
    setBusyTimerId(timer.id);
    try {
      await runModuleQueryWrite(queryClient, channelId, "timers", "panel", (revision) =>
        setTimerEnabled(channelId, timer.id, enabled, requireBaselineRevision(revision)), {
        baselineRevision: timer.revision,
        updateCache: (current, updated) => withTimer(current, updated),
      });
    } catch { notify({ tone: "error", message: labels.saveError }); }
    finally { setBusyTimerId(null); }
  };

  const remove = async (): Promise<void> => {
    if (deleteTarget === null || busyTimerId !== null || dirty) return;
    setPending(true);
    setDeleteError(null);
    const timerId = deleteTarget.id;
    const startedSwitch = editorSwitch.current;
    try {
      await runModuleQueryWrite(queryClient, channelId, "timers", "panel", (revision) =>
        deleteTimer(channelId, timerId, requireBaselineRevision(revision)), {
        baselineRevision: deleteTarget.revision,
        updateCache: (current) => withoutTimer(current, timerId),
      });
      setDeleteTarget(null);
      if (editorSwitch.current === startedSwitch && selectedId === timerId) closeEditorNow();
    } catch { setDeleteError(labels.deleteError); }
    finally { setPending(false); }
  };

  const reloadCurrent = (): void => {
    if (editing === null) return;
    const startedSwitch = editorSwitch.current;
    setPending(true);
    void refetchModuleQueryData<TimersPanelData>(queryClient, channelId, "timers", "panel").then((latestData) => {
      if (editorSwitch.current !== startedSwitch) return;
      const latest = latestData.timers.find((timer) => timer.id === editing.id);
      if (latest === undefined) {
        closeEditorNow();
        return;
      }
      const next = draftFromTimer(latest);
      dirtyRef.current = false;
      setEditing(latest);
      setDraft(cloneDraft(next));
      setBaselineDraft(cloneDraft(next));
      setError(null);
      setServerConflict(false);
      setAttemptedSave(false);
    }).catch(() => {
      // Keep the rejected draft and conflict visible so the user can retry the reload.
      notify({ tone: "error", message: labels.loadError });
    }).finally(() => {
      setPending(false);
    });
  };

  const triggerOptions = [
    { value: "interval", label: labels.interval },
    { value: "stream_start", label: labels.streamStart },
    { value: "time_of_day", label: labels.timeOfDay },
    { value: "before_event", label: labels.beforeEvent },
  ];
  const listStatus = query.isPending ? "loading" : data === undefined ? "error" : data.timers.length === 0 ? "empty" : "success";
  const createReason = !canManage ? labels.roleLocked
    : data !== undefined && data.timers.length >= TIMER_MAXIMUM_COUNT ? labels.limitReached : undefined;
  const activeTimerFilters = search.trim().length === 0 ? undefined : search.trim();
  const listToolbar = <ListToolbar
    className="timers-panel__list-toolbar"
    {...(language === undefined ? {} : { language })}
    searchLabel={labels.search}
    searchPlaceholder={labels.search}
    searchClearLabel={common.clearSearch}
    searchValue={search}
    onSearchChange={setSearch}
    filtersLabel={labels.title}
    create={{ label: labels.add, onClick: openCreate, disabled: editorPending || createReason !== undefined, ...(createReason === undefined ? {} : { reason: createReason }) }}
    usage={{
      count: data?.timers.length ?? 0,
      maximum: TIMER_MAXIMUM_COUNT,
      ...(activeTimerFilters === undefined ? {} : { filteredCount: visibleTimers.length }),
      copy: {
        countSuffix: labels.timerCount,
        filteredInfix: common.of,
        filteredSuffix: labels.timerCount,
        limitInfix: common.of,
        limitSuffix: labels.timerCount,
        loadedSuffix: labels.timerCount,
      },
    }}
    {...(activeTimerFilters === undefined ? {} : {
      activeFilters: activeTimerFilters,
      activeFiltersLabel: common.activeFilters,
      resetLabel: common.reset,
      onReset: () => { setSearch(""); },
    })}
  />;

  const timerList = data?.timers.length === 0 ? null : <LoadState
    variant="panel-720"
    status={listStatus}
    loading={<LoadStateLines rows={7} height={42} />}
    empty={<div />}
    error={<p className="muted">{labels.loadError}</p>}
    queryError={{ message: labels.loadError, onRetry: () => { void query.refetch(); } }}
    refreshError={query.isRefetchError}
  >
    {visibleTimers.length === 0 ? <p className="timer-list__empty">{labels.noSearchResults}</p> : <div className="timer-list">
      {visibleTimers.map((timer) => <article key={timer.id} className={`timer-list__row${selectedId === timer.id ? " is-selected" : ""}`}>
        <button type="button" className="timer-list__select" aria-current={selectedId === timer.id ? "true" : undefined} disabled={editorPending} onClick={() => { selectTimer(timer); }}>
          <span className={`timer-list__dot${timer.enabled ? " is-on" : ""}`} aria-hidden="true" />
          <span className="timer-list__copy">
            <strong>{timer.name}</strong>
            <small>{nextRunLabel(timer, labels)} · {timer.nextRunAt === null ? labels.noNextRun : formatRelativeTime(timer.nextRunAt, now, language ?? "de", timeZone).label}</small>
          </span>
        </button>
        <SwitchPrimitive
          aria-label={`${timer.name}: ${timer.enabled ? labels.enabled : labels.disabled}`}
          checked={timer.enabled}
          aria-busy={busyTimerId === timer.id}
          disabled={!canOperate || editorPending || deleteTarget !== null || dirty}
          onCheckedChange={(enabled) => { void toggle(timer, enabled); }}
        />
      </article>)}
    </div>}
  </LoadState>;

  const title = draft === null ? labels.selectTimer : editing === null ? labels.create : draft.name || labels.edit;
  const relativeRun = (timestamp: string): string => formatTimerRunLabel(timestamp, now, language ?? "de", timeZone);
  const selectedMeta = selectedTimer === undefined ? undefined : `${labels.lastRun}: ${selectedTimer.lastRunAt === null ? labels.neverRun : relativeRun(selectedTimer.lastRunAt)} · ${nextRunLabel(selectedTimer, labels)}: ${selectedTimer.nextRunAt === null ? labels.noNextRun : relativeRun(selectedTimer.nextRunAt)}`;

  const detail = draft === null ? <EmptyState title={labels.selectTimer} description={labels.selectTimerDescription}
    {...(canManage && createReason === undefined ? { action: { label: labels.add, onClick: openCreate } } : {})} /> : (
    <div className="timer-editor">
      <PageHeader
        kind="timers"
        icon={null}
        title={title}
        {...(selectedMeta === undefined ? {} : { meta: selectedMeta })}
        {...(editing === null || selectedTimer === undefined ? {} : { moduleSwitch: <div className="timer-header__switch">
          <SwitchPrimitive
            aria-label={`${selectedTimer.name}: ${selectedTimer.enabled ? labels.enabled : labels.disabled}`}
            checked={selectedTimer.enabled}
            disabled={!canOperate || editorPending || deleteTarget !== null || dirty}
            onCheckedChange={(enabled) => { void toggle(selectedTimer, enabled); }}
          />
          <span>{selectedTimer.enabled ? labels.enabled : labels.disabled}</span>
        </div> })}
        {...(!canManage ? { lockHint: labels.roleLocked } : {})}
        {...(editing === null ? {} : { actions: <ActionMenu label={common.moreActions} items={[{
          label: labels.delete,
          onSelect: () => { if (canManage) { setDeleteTarget(editing); setDeleteError(null); } },
          disabled: !canManage || editorPending || dirty,
          danger: true,
          ...(!canManage ? { description: labels.deleteOperatorReason }
            : dirty ? { description: labels.deleteNeedsSaved }
              : editorPending ? { description: common.saving } : {}),
        }]} />})}
        {...(canManage ? { save: {
          dirty,
          pending: editorPending,
          invalid: input === null,
          invalidMessage: labels.saveError,
          onInvalidSave: () => { setAttemptedSave(true); },
          persistent: true,
          ...(error === null ? {} : { error }),
          ...(serverConflict && editing !== null ? { conflict: { message: labels.conflict, reloadLabel: labels.reload, onReload: reloadCurrent } } : {}),
          onSave: () => { void saveDraft(); },
          onDiscard: discardDraft,
          saveLabel: editing === null ? labels.create : labels.save,
          discardLabel: common.discard,
          savedLabel: common.saved,
          pendingLabel: common.saving,
        } } : {})}
      />

      {canManage ? <div className="timer-editor__body">
        <Section title={labels.general}>
          <Field label={labels.name} value={draft.name} onChange={(name) => patchDraft({ name })} maxLength={60} countLabel={(count, max) => `${String(count)}/${String(max)}`} disabled={editorPending}
            {...(attemptedSave && draft.name.trim().length === 0 ? { error: labels.nameRequired } : {})} />
        </Section>
        <Section title={labels.message}>
          <div className="timer-editor__message-grid">
            <div>
              <TemplateTextField
                label={labels.message}
                hint={labels.messageHint}
                value={draft.messageText}
                onChange={(messageText) => { patchDraft({ messageText }); }}
                maxLength={500}
                variables={data?.variables ?? []}
                preview={() => previewText}
                previewLabel={labels.preview}
                previewStatus={<span className="timer-editor__preview-status" role={previewBusy ? "status" : undefined}>{previewBusy ? labels.previewLoading : ""}</span>}
                previewSpeaker={labels.previewBot}
                messages={labels.templateMessages}
                minRows={3}
                disabled={editorPending}
                required
              />
              <p className="form-error timer-editor__field-error" role={attemptedSave && draft.messageText.trim().length === 0 ? "alert" : undefined}>
                {attemptedSave && draft.messageText.trim().length === 0 ? labels.messageRequired : ""}
              </p>
            </div>
          </div>
        </Section>

        <Section title={labels.when}>
          <Select label={labels.trigger} value={draft.type} onChange={(type) => patchDraft({ type: (type ?? "interval") as TriggerType })} options={triggerOptions} disabled={editorPending} />
          {draft.type === "interval" ? <div className="timer-editor__intervals">
            <SwitchSection title={labels.live} hint={labels.liveRule} checked={draft.live !== null} onChange={(enabled) => patchDraft({ live: enabled ? emptyIntervalDraft() : null })} pending={editorPending}>
              <div className="timer-editor__unit-grid">
                <UnitInput label={labels.minutes} value={draft.live?.minutes ?? ""} onChange={(minutes) => patchDraft({ live: draft.live === null ? null : { ...draft.live, minutes } })} min={1} max={1_440} unit={labels.minutesUnit} required />
                <UnitInput label={labels.messageCount} hint={labels.minimumMessagesHint} placeholder={labels.minimumMessagesPlaceholder} value={draft.live?.minimumMessages ?? ""} onChange={(minimumMessages) => patchDraft({ live: draft.live === null ? null : { ...draft.live, minimumMessages } })} min={1} max={100_000} unit={labels.messagesUnit} />
              </div>
            </SwitchSection>
            <SwitchSection title={labels.offline} hint={labels.offlineRule} checked={draft.offline !== null} onChange={(enabled) => patchDraft({ offline: enabled ? emptyIntervalDraft() : null })} pending={editorPending}>
              <div className="timer-editor__unit-grid">
                <UnitInput label={labels.minutes} value={draft.offline?.minutes ?? ""} onChange={(minutes) => patchDraft({ offline: draft.offline === null ? null : { ...draft.offline, minutes } })} min={1} max={1_440} unit={labels.minutesUnit} required />
                <UnitInput label={labels.messageCount} hint={labels.minimumMessagesHint} placeholder={labels.minimumMessagesPlaceholder} value={draft.offline?.minimumMessages ?? ""} onChange={(minimumMessages) => patchDraft({ offline: draft.offline === null ? null : { ...draft.offline, minimumMessages } })} min={1} max={100_000} unit={labels.messagesUnit} />
              </div>
            </SwitchSection>
          </div> : null}
          {draft.type === "stream_start" ? <UnitInput label={labels.minutes} value={draft.minutes} onChange={(minutes) => patchDraft({ minutes })} min={1} max={1_440} unit={labels.minutesUnit} required disabled={editorPending} /> : null}
          {draft.type === "time_of_day" ? <div className="timer-editor__schedule-fields">
            <Field label={labels.time} value={draft.time} onChange={(time) => patchDraft({ time })} placeholder="HH:MM" required disabled={editorPending} />
            <div className="timer-weekdays" role="group" aria-label={labels.weekdays}>
              {labels.weekdaysNames.map((day, index) => {
                const allDays = draft.weekdays.length === 0;
                const checked = allDays || draft.weekdays.includes(index);
                return <div className="timer-weekday" key={day}>
                  <SwitchPrimitive aria-label={day} checked={checked} disabled={editorPending} onCheckedChange={() => {
                    const days = allDays ? labels.weekdaysNames.map((_, dayIndex) => dayIndex).filter((dayIndex) => dayIndex !== index)
                      : checked ? draft.weekdays.filter((selected) => selected !== index) : [...draft.weekdays, index].sort((left, right) => left - right);
                    patchDraft({ weekdays: days.length === 7 ? [] : days });
                  }} />
                  <span>{day}</span>
                </div>;
              })}
            </div>
            <SwitchRow label={labels.alsoOffline} checked={draft.alsoOffline} disabled={editorPending} onChange={(alsoOffline) => patchDraft({ alsoOffline })} />
          </div> : null}
          {draft.type === "before_event" ? <div className="timer-editor__unit-grid">
            <Select label={labels.eventSource} value={draft.sourceId || null} onChange={(sourceId) => patchDraft({ sourceId: sourceId ?? "" })} options={sourceOptions} required disabled={editorPending} />
            <UnitInput label={labels.before} value={draft.minutes} onChange={(minutes) => patchDraft({ minutes })} min={1} max={1_440} unit={labels.minutesUnit} required disabled={editorPending} />
          </div> : null}
          {draft.type === "interval" ? <RuleNote>{labels.liveRule}{draft.offline === null ? "" : ` ${labels.offlineRule}`}</RuleNote> : null}
        </Section>

        <Section title={labels.chatTarget}>
          <ChatTargetField
            label={labels.chatTarget}
            {...(language === undefined ? {} : { language })}
            value={draft.chatTarget}
            allowed={["all_chats", "source_only"]}
            {...(channelSettings.data?.defaultChatTarget === undefined ? {} : { effectiveDefault: channelSettings.data.defaultChatTarget })}
            disabled={editorPending}
            onChange={(chatTarget) => { if (chatTarget === "all_chats" || chatTarget === "source_only") patchDraft({ chatTarget }); }}
          />
        </Section>
      </div> : <>
        <dl className="timer-editor__properties">
          <div><dt>{labels.name}</dt><dd>{draft.name}</dd></div>
          <div><dt>{labels.message}</dt><dd><pre>{draft.messageText}</pre></dd></div>
          <div><dt>{labels.trigger}</dt><dd>{triggerTitle(draft.type, labels)} · {selectedTimer === undefined || data === undefined ? "" : triggerDetail(selectedTimer, data, labels, language ?? "de")}</dd></div>
          <div><dt>{labels.chatTarget}</dt><dd>{selectedTimer === undefined ? "" : targetLabel(selectedTimer.chatTarget)}</dd></div>
          <div><dt>{labels.lastRun}</dt><dd>{selectedTimer?.lastRunAt === null || selectedTimer === undefined ? labels.neverRun : relativeRun(selectedTimer.lastRunAt)}</dd></div>
          <div><dt>{labels.nextRun}</dt><dd>{selectedTimer?.nextRunAt === null || selectedTimer === undefined ? labels.noNextRun : relativeRun(selectedTimer.nextRunAt)}</dd></div>
        </dl>
      </>}
    </div>
  );

  return <section className="timers-panel" aria-label={labels.title}>
    <CollectionPage
      title={labels.title}
      toolbar={listToolbar}
      list={timerList}
      detail={detail}
      empty={<EmptyState title={labels.emptyTitle} description={labels.empty} />}
      detailOpen={mobileDetailOpen}
      backLabel={labels.back}
      closeDetailDisabled={editorPending}
      onCloseDetail={closeEditor}
    />
    <ConfirmDialog
      opened={deleteTarget !== null}
      title={labels.delete}
      description={labels.deleteConfirm}
      confirmLabel={labels.delete}
      cancelLabel={common.cancel}
      danger
      pending={pending}
      {...(deleteError === null ? {} : { error: deleteError })}
      onConfirm={() => { void remove(); }}
      onCancel={() => { if (!pending) setDeleteTarget(null); }}
    />
    <ConfirmDialog
      opened={draftGuard.confirmOpen}
      title={labels.draftGuardTitle}
      description={labels.draftGuardDescription}
      confirmLabel={labels.discardAndSwitch}
      cancelLabel={labels.continueEditing}
      onCancel={draftGuard.continueEditing}
      onConfirm={draftGuard.discardAndSwitch}
      {...(canManage && input !== null ? { alternative: { label: labels.saveAndSwitch, onClick: () => { void draftGuard.saveAndSwitch(); } } } : {})}
      pending={draftGuard.saving}
      {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
    />
  </section>;
}
