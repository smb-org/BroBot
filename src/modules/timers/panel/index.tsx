import { useMemo, useState, type ReactElement } from "react";

import { runModuleQueryWrite, useChannelSettings, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { formatTimestamp } from "../../../dashboard/locale";
import { Button, ChatTargetField, ChatPreview, ConfirmDialog, Dialog, Field, FormDialog, InspectorSection, LoadState, LoadStateLines, Section, Select, SwitchRow, SwitchSection, TemplateTextField, UnitInput, notify } from "../../../dashboard/ui";
import { Switch as SwitchPrimitive } from "../../../dashboard/ui/primitives/switch";
import type { ModulePanelProperties } from "../../contract";
import type { Timer, TimerTrigger } from "../contracts";
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
  chatTarget: null,
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
  const channelSettings = useChannelSettings(channelId);
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery(channelId, "timers", "panel", (signal) => loadTimersPanel(channelId, signal));
  const data = query.data;
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TimerDraft | null>(null);
  const [editing, setEditing] = useState<Timer | null>(null);
  const [pending, setPending] = useState(false);
  const [busyTimerId, setBusyTimerId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Timer | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sourceOptions = useMemo(() => (data?.sources ?? []).map((source) => ({
    value: source.id,
    label: source.label[language ?? "de"],
  })), [data?.sources, language]);

  const openCreate = (): void => {
    setEditing(null);
    setDraft(emptyDraft(data?.sources ?? []));
  };

  const openEdit = (timer: Timer): void => {
    setEditing(timer);
    setDraft(draftFromTimer(timer));
  };

  const preview = async (messageText: string): Promise<void> => {
    if (messageText.trim().length === 0) return;
    setPreviewBusy(true);
    try { setPreviewText(await previewTimerText(channelId, messageText)); }
    catch { setPreviewText(labels.saveError); }
    finally { setPreviewBusy(false); }
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    const input = inputFromDraft(draft);
    if (input === null) {
      setError(labels.saveError);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await runModuleQueryWrite(queryClient, channelId, "timers", "panel", (revision) =>
        editing === null ? createTimer(channelId, input) : updateTimer(channelId, editing.id, input, requireBaselineRevision(revision)), {
        baselineRevision: editing?.revision ?? null,
        updateCache: (current, timer) => withTimer(current, timer),
      });
      setDraft(null);
      setEditing(null);
    } catch (failure: unknown) {
      const code = timerErrorCode(failure);
      setError(code === "timer_text_input_dependent" ? labels.inputDependentText
        : code === "timer_text_block_missing" ? labels.missingTextBlock
          : code === "timer_limit_reached" ? labels.limitReached : labels.saveError);
    } finally { setPending(false); }
  };

  const toggle = async (timer: Timer, enabled: boolean): Promise<void> => {
    if (busyTimerId !== null) return;
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
    if (deleteTarget === null) return;
    setPending(true);
    setDeleteError(null);
    try {
      const timerId = deleteTarget.id;
      await runModuleQueryWrite(queryClient, channelId, "timers", "panel", (revision) =>
        deleteTimer(channelId, timerId, requireBaselineRevision(revision)), {
        baselineRevision: deleteTarget.revision,
        updateCache: (current) => withoutTimer(current, timerId),
      });
      setDeleteTarget(null);
    } catch { setDeleteError(labels.deleteError); }
    finally { setPending(false); }
  };

  const patchDraft = (change: Partial<TimerDraft>): void => setDraft((current) => current === null ? null : { ...current, ...change });
  const triggerOptions = [
    { value: "interval", label: labels.interval },
    { value: "stream_start", label: labels.streamStart },
    { value: "time_of_day", label: labels.timeOfDay },
    { value: "before_event", label: labels.beforeEvent },
  ];
  const listStatus = query.isPending ? "loading" : data === undefined ? "error" : data.timers.length === 0 ? "empty" : "success";

  return (
    <section aria-label={labels.title}>
      <InspectorSection title={labels.title}>
        <Button variant="primary" disabled={!canManage} onClick={openCreate}>{labels.add}</Button>
        {canManage ? null : <p className="lock-reason">{labels.roleLocked}</p>}
        <div data-testid="timers-list-slot" style={{ height: "calc(var(--s10) * 19)", overflow: "hidden" }}>
        <LoadState variant="panel-720" status={listStatus}
          loading={<LoadStateLines rows={7} height={34} />}
          empty={<p className="muted">{labels.empty}</p>}
          error={<p className="muted">{labels.loadError}</p>}
          queryError={{ message: labels.loadError, onRetry: () => { void query.refetch(); } }}
          refreshError={query.isRefetchError}
        >
        <div className="state-list" style={{ height: "calc(var(--s10) * 18)", overflowY: "auto" }}>
          {(data?.timers ?? []).map((timer) => (
            <article key={timer.id} className="timer-row">
              <div className="timer-row__copy">
                <strong>{timer.name}</strong>
                <span>{labels.trigger} · {triggerTitle(timer.trigger.type, labels)}</span>
                <span>{triggerDetail(timer, data as TimersPanelData, labels, language ?? "de")}</span>
                <span>{labels.message} · {timer.messageText}</span>
                <span>{labels.chatTarget} · {timer.chatTarget === null ? labels.chatTargetDefault : labels.chatTargetLabels[timer.chatTarget]}</span>
                <span>{nextRunLabel(timer, labels)} ·{timer.nextRunAt === null ? labels.noNextRun : formatTimestamp(timer.nextRunAt)}</span>
              </div>
              <div className="timer-row__actions">
                <SwitchPrimitive
                  aria-label={`${timer.name}: ${timer.enabled ? labels.enabled : labels.disabled}`}
                  checked={timer.enabled}
                  aria-busy={busyTimerId === timer.id}
                  disabled={!canOperate || busyTimerId === timer.id}
                  onCheckedChange={(enabled) => { void toggle(timer, enabled); }}
                />
                <Button variant="subtle" onClick={() => { void preview(timer.messageText); }} disabled={timer.messageText.trim().length === 0}>{labels.preview}</Button>
                <Button variant="neutral" disabled={!canManage} onClick={() => { openEdit(timer); }}>{labels.edit}</Button>
                <Button variant="subtle" danger onClick={() => { setDeleteTarget(timer); setDeleteError(null); }} disabled={!canManage}>{labels.delete}</Button>
              </div>
            </article>
          ))}
        </div>
        </LoadState>
        </div>
      </InspectorSection>

      <FormDialog
        opened={draft !== null}
        title={editing === null ? labels.create : labels.edit}
        confirmLabel={labels.save}
        cancelLabel={labels.cancel}
        onConfirm={() => { void save(); }}
        onCancel={() => { if (!pending) { setDraft(null); setEditing(null); setError(null); } }}
        pending={pending}
        confirmDisabled={draft === null || inputFromDraft(draft) === null}
        {...(error === null ? {} : { error })}
      >
        {draft === null ? null : <div className="module-stack">
          <Field label={labels.name} value={draft.name} onChange={(name) => patchDraft({ name })} maxLength={60} countLabel={(count, max) => `${String(count)}/${String(max)}`} required />
          <TemplateTextField
            label={labels.message}
            hint={labels.messageHint}
            value={draft.messageText}
            onChange={(messageText) => patchDraft({ messageText })}
            maxLength={500}
            variables={data?.variables ?? []}
            messages={labels.templateMessages}
            minRows={2}
            disabled={pending}
            required
          />
          <ChatTargetField
            label={labels.chatTarget}
            value={draft.chatTarget}
            {...(channelSettings.data === undefined ? {} : { effectiveDefault: channelSettings.data.defaultChatTarget })}
            allowed={["all_chats", "source_only", "channel_default"]}
            disabled={pending}
            onChange={(chatTarget) => { if (chatTarget !== "where_asked") patchDraft({ chatTarget }); }}
          />
          <Select
            label={labels.trigger}
            value={draft.type}
            onChange={(type) => patchDraft({ type: (type ?? "interval") as TriggerType })}
            options={triggerOptions}
          />

          {draft.type === "interval" ? <Section title={labels.interval}>
            <div className="module-stack">
              <SwitchSection title={labels.live} hint={labels.liveOff} checked={draft.live !== null} onChange={(enabled) => patchDraft({ live: enabled ? emptyIntervalDraft() : null })} pending={pending}>
                <div className="module-stack">
                  <UnitInput
                    label={labels.minutes}
                    value={draft.live?.minutes ?? ""}
                    onChange={(minutes) => patchDraft({ live: draft.live === null ? null : { ...draft.live, minutes } })}
                    min={1}
                    max={1_440}
                    unit={labels.minutesUnit}
                    required
                  />
                  <UnitInput
                    label={labels.messageCount}
                    value={draft.live?.minimumMessages ?? ""}
                    onChange={(minimumMessages) => patchDraft({ live: draft.live === null ? null : { ...draft.live, minimumMessages } })}
                    min={1}
                    max={100_000}
                  />
                </div>
              </SwitchSection>
              <SwitchSection title={labels.offline} hint={labels.offlineOff} checked={draft.offline !== null} onChange={(enabled) => patchDraft({ offline: enabled ? emptyIntervalDraft() : null })} pending={pending}>
                <div className="module-stack">
                  <UnitInput
                    label={labels.minutes}
                    value={draft.offline?.minutes ?? ""}
                    onChange={(minutes) => patchDraft({ offline: draft.offline === null ? null : { ...draft.offline, minutes } })}
                    min={1}
                    max={1_440}
                    unit={labels.minutesUnit}
                    required
                  />
                  <UnitInput
                    label={labels.messageCount}
                    value={draft.offline?.minimumMessages ?? ""}
                    onChange={(minimumMessages) => patchDraft({ offline: draft.offline === null ? null : { ...draft.offline, minimumMessages } })}
                    min={1}
                    max={100_000}
                  />
                </div>
              </SwitchSection>
            </div>
          </Section> : null}
          {draft.type === "stream_start" ? <UnitInput
            label={labels.minutes}
            value={draft.minutes}
            onChange={(minutes) => patchDraft({ minutes })}
            min={1}
            max={1_440}
            unit={labels.minutesUnit}
            required
          /> : null}
          {draft.type === "time_of_day" ? <>
            <Field label={labels.time} value={draft.time} onChange={(time) => patchDraft({ time })} placeholder="HH:MM" required />
            <div className="timer-weekdays" role="group" aria-label={labels.weekdays}>
              {labels.weekdaysNames.map((day, index) => {
                const allDays = draft.weekdays.length === 0;
                const checked = allDays || draft.weekdays.includes(index);
                return <div className="timer-weekday" key={day}>
                  <SwitchPrimitive aria-label={day} checked={checked} onCheckedChange={() => {
                  const days = allDays ? labels.weekdaysNames.map((_, dayIndex) => dayIndex).filter((dayIndex) => dayIndex !== index)
                    : checked ? draft.weekdays.filter((selected) => selected !== index) : [...draft.weekdays, index].sort((left, right) => left - right);
                  patchDraft({ weekdays: days.length === 7 ? [] : days });
                  }} />
                  <span>{day}</span>
                </div>;
              })}
            </div>
            <SwitchRow label={labels.alsoOffline} checked={draft.alsoOffline} onChange={(alsoOffline) => patchDraft({ alsoOffline })} />
          </> : null}
          {draft.type === "before_event" ? <>
            <Select label={labels.eventSource} value={draft.sourceId || null} onChange={(sourceId) => patchDraft({ sourceId: sourceId ?? "" })} options={sourceOptions} required />
            <UnitInput label={labels.before} value={draft.minutes} onChange={(minutes) => patchDraft({ minutes })} min={1} max={1_440} unit={labels.minutesUnit} required />
          </> : null}

          <div className="inspector-actions">
            <Button type="button" variant="neutral" onClick={() => { void preview(draft.messageText); }} disabled={draft.messageText.trim().length === 0 || previewBusy}>{labels.preview}</Button>
          </div>
        </div>}
      </FormDialog>

      <Dialog opened={previewText !== null} title={labels.previewTitle} onClose={() => setPreviewText(null)} pending={previewBusy}>
        {previewText === null ? null : <ChatPreview label={labels.preview} speaker={labels.previewBot} text={previewText} countLabel={labels.characterCount(previewText.length)} />}
      </Dialog>

      <ConfirmDialog
        opened={deleteTarget !== null}
        title={labels.delete}
        description={labels.deleteConfirm}
        confirmLabel={labels.delete}
        cancelLabel={labels.cancel}
        danger
        pending={pending}
        {...(deleteError === null ? {} : { error: deleteError })}
        onConfirm={() => { void remove(); }}
        onCancel={() => { if (!pending) setDeleteTarget(null); }}
      />
    </section>
  );
}
