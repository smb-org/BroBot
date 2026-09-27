import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { formatTimestamp } from "../../../dashboard/locale";
import { Button, ChatPreview, ConfirmDialog, Dialog, Field, InspectorSection, NumberField, Select, Switch } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { Timer, TimerMutationInput, TimerTrigger } from "../contracts";
import { timersTexts } from "./locale";
import {
  createTimer,
  deleteTimer,
  loadTimersPanel,
  previewTimerBlock,
  setTimerEnabled,
  timerErrorCode,
  updateTimer,
  type TimersPanelData,
} from "./service";

type TriggerType = TimerTrigger["type"];

interface TimerDraft {
  name: string;
  blockName: string;
  type: TriggerType;
  minutes: number | "";
  minimumMessages: number | "";
  useMinimumMessages: boolean;
  time: string;
  weekdays: number[];
  alsoOffline: boolean;
  sourceId: string;
}

const emptyDraft = (sources: TimersPanelData["sources"]): TimerDraft => ({
  name: "",
  blockName: "",
  type: "interval",
  minutes: 30,
  minimumMessages: 10,
  useMinimumMessages: false,
  time: "12:00",
  weekdays: [],
  alsoOffline: false,
  sourceId: sources[0]?.id ?? "",
});

const draftFromTimer = (timer: Timer): TimerDraft => {
  const trigger = timer.trigger;
  if (trigger.type === "interval") return {
    ...emptyDraft([]), name: timer.name, blockName: timer.blockName, type: trigger.type,
    minutes: trigger.minutes, useMinimumMessages: trigger.minimumMessages !== undefined,
    minimumMessages: trigger.minimumMessages ?? 10,
  };
  if (trigger.type === "stream_start") return {
    ...emptyDraft([]), name: timer.name, blockName: timer.blockName, type: trigger.type, minutes: trigger.minutes,
  };
  if (trigger.type === "time_of_day") return {
    ...emptyDraft([]), name: timer.name, blockName: timer.blockName, type: trigger.type,
    time: trigger.time, weekdays: [...trigger.weekdays], alsoOffline: trigger.alsoOffline,
  };
  return {
    ...emptyDraft([]), name: timer.name, blockName: timer.blockName, type: trigger.type,
    minutes: trigger.minutes, sourceId: trigger.sourceId,
  };
};

const inputFromDraft = (draft: TimerDraft): TimerMutationInput | null => {
  if (typeof draft.minutes !== "number" && draft.type !== "time_of_day") return null;
  if (draft.name.trim().length === 0 || draft.blockName.length === 0) return null;
  let trigger: TimerTrigger;
  if (draft.type === "interval") {
    trigger = {
      type: "interval",
      minutes: draft.minutes as number,
      ...(draft.useMinimumMessages ? { minimumMessages: draft.minimumMessages as number } : {}),
    };
  } else if (draft.type === "stream_start") {
    trigger = { type: "stream_start", minutes: draft.minutes as number };
  } else if (draft.type === "time_of_day") {
    trigger = { type: "time_of_day", time: draft.time, weekdays: draft.weekdays, alsoOffline: draft.alsoOffline };
  } else {
    if (draft.sourceId.length === 0) return null;
    trigger = { type: "before_event", sourceId: draft.sourceId, minutes: draft.minutes as number };
  }
  return { name: draft.name.trim(), blockName: draft.blockName, trigger };
};

const triggerTitle = (type: TriggerType, labels: ReturnType<typeof timersTexts>): string => {
  if (type === "interval") return labels.interval;
  if (type === "stream_start") return labels.streamStart;
  if (type === "time_of_day") return labels.timeOfDay;
  return labels.beforeEvent;
};

const triggerDetail = (timer: Timer, data: TimersPanelData, labels: ReturnType<typeof timersTexts>, language: "de" | "en"): string => {
  const trigger = timer.trigger;
  if (trigger.type === "interval") {
    const threshold = trigger.minimumMessages === undefined ? "" : ` · ${String(trigger.minimumMessages)} ${labels.messageCount.toLowerCase()}`;
    return `${String(trigger.minutes)} ${labels.minutes.toLowerCase()}${threshold}`;
  }
  if (trigger.type === "stream_start") return `${String(trigger.minutes)} ${labels.minutes.toLowerCase()}`;
  if (trigger.type === "time_of_day") {
    const selectedDays = trigger.weekdays.length === 0 ? labels.everyDay : trigger.weekdays.map((day) => labels.weekdaysNames[day]).join(", ");
    return `${trigger.time} · ${selectedDays}${trigger.alsoOffline ? ` · ${labels.alsoOffline}` : ""}`;
  }
  const label = data.sources.find((source) => source.id === trigger.sourceId)?.label[language] ?? trigger.sourceId;
  return `${String(trigger.minutes)} ${labels.minutes.toLowerCase()} ${labels.beforeEvent.toLowerCase()} · ${label}`;
};

export default function TimersPanel({ channelId, language, canManage = true, canOperate = true }: ModulePanelProperties): ReactElement {
  const labels = timersTexts(language);
  const [data, setData] = useState<TimersPanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TimerDraft | null>(null);
  const [editing, setEditing] = useState<Timer | null>(null);
  const [pending, setPending] = useState(false);
  const [busyTimerId, setBusyTimerId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Timer | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try { setData(await loadTimersPanel(channelId)); }
    catch { setError(labels.loadError); }
    finally { setLoading(false); }
  }, [channelId, labels.loadError]);

  useEffect(() => {
    let active = true;
    void loadTimersPanel(channelId)
      .then((value) => { if (active) setData(value); })
      .catch(() => { if (active) setError(labels.loadError); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [channelId, labels.loadError]);

  const sourceOptions = useMemo(() => (data?.sources ?? []).map((source) => ({
    value: source.id,
    label: source.label[language ?? "de"],
  })), [data?.sources, language]);
  const blockOptions = useMemo(() => (data?.blocks ?? []).map((name) => ({ value: name, label: name })), [data?.blocks]);

  const openCreate = (): void => {
    setEditing(null);
    setDraft(emptyDraft(data?.sources ?? []));
  };

  const openEdit = (timer: Timer): void => {
    setEditing(timer);
    setDraft(draftFromTimer(timer));
  };

  const preview = async (blockName: string): Promise<void> => {
    if (blockName.length === 0) return;
    setPreviewBusy(true);
    try { setPreviewText(await previewTimerBlock(channelId, blockName)); }
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
      if (editing === null) await createTimer(channelId, input);
      else await updateTimer(channelId, editing, input);
      setDraft(null);
      setEditing(null);
      await reload();
    } catch (failure: unknown) {
      const code = timerErrorCode(failure);
      setError(code === "timer_block_input_dependent" ? labels.inputDependentBlock
        : code === "timer_block_missing" ? labels.blockMissing
          : code === "timer_limit_reached" ? labels.limitReached : labels.saveError);
    } finally { setPending(false); }
  };

  const toggle = async (timer: Timer, enabled: boolean): Promise<void> => {
    if (busyTimerId !== null) return;
    setBusyTimerId(timer.id);
    try {
      await setTimerEnabled(channelId, timer, enabled);
      await reload();
    } catch { setError(labels.saveError); }
    finally { setBusyTimerId(null); }
  };

  const remove = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setPending(true);
    setDeleteError(null);
    try {
      await deleteTimer(channelId, deleteTarget);
      setDeleteTarget(null);
      await reload();
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

  return (
    <section aria-label={labels.title}>
      <InspectorSection title={labels.title}>
        {canManage ? <Button variant="primary" onClick={openCreate}>{labels.add}</Button> : <p className="lock-reason">{labels.roleLocked}</p>}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {loading ? <p className="muted">…</p> : null}
        {!loading && data?.timers.length === 0 ? <p className="muted">{labels.empty}</p> : null}
        <div className="state-list">
          {(data?.timers ?? []).map((timer) => (
            <article key={timer.id} className="timer-row">
              <div className="timer-row__copy">
                <strong>{timer.name}</strong>
                <span>{labels.trigger} · {triggerTitle(timer.trigger.type, labels)}</span>
                <span>{triggerDetail(timer, data as TimersPanelData, labels, language ?? "de")}</span>
                <span>{labels.block} · <code>{timer.blockName}</code></span>
                <span>{labels.nextRun} · {timer.nextRunAt === null ? labels.noNextRun : formatTimestamp(timer.nextRunAt)}</span>
              </div>
              <div className="timer-row__actions">
                <Switch
                  ariaLabel={`${timer.name}: ${timer.enabled ? labels.enabled : labels.disabled}`}
                  checked={timer.enabled}
                  disabled={!canOperate}
                  pending={busyTimerId === timer.id}
                  onChange={(enabled) => { void toggle(timer, enabled); }}
                />
                <Button variant="subtle" onClick={() => { void preview(timer.blockName); }}>{labels.preview}</Button>
                <Button variant="neutral" disabled={!canManage} onClick={() => { openEdit(timer); }}>{labels.edit}</Button>
                <Button variant="subtle" danger onClick={() => { setDeleteTarget(timer); setDeleteError(null); }} disabled={!canManage}>{labels.delete}</Button>
              </div>
            </article>
          ))}
        </div>
      </InspectorSection>

      <Dialog
        opened={draft !== null}
        title={editing === null ? labels.create : labels.edit}
        onClose={() => { if (!pending) { setDraft(null); setEditing(null); setError(null); } }}
        pending={pending}
      >
        {draft === null ? null : <form className="module-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Field label={labels.name} value={draft.name} onChange={(name) => patchDraft({ name })} maxLength={60} countLabel={(count, max) => `${String(count)}/${String(max)}`} required />
          <Select
            label={labels.block}
            value={draft.blockName || null}
            onChange={(blockName) => patchDraft({ blockName: blockName ?? "" })}
            options={blockOptions}
            placeholder={labels.block}
            required
          />
          {blockOptions.length === 0 ? <p className="muted">{labels.noBlocks}</p> : null}
          <Select
            label={labels.trigger}
            value={draft.type}
            onChange={(type) => patchDraft({ type: (type ?? "interval") as TriggerType })}
            options={triggerOptions}
          />

          {draft.type === "interval" || draft.type === "stream_start" ? <NumberField
            label={labels.minutes}
            value={draft.minutes}
            onChange={(minutes) => patchDraft({ minutes })}
            min={1}
            max={1_440}
            unit="min"
            required
          /> : null}
          {draft.type === "interval" ? <>
            <Switch label={labels.minimumMessages} checked={draft.useMinimumMessages} onChange={(useMinimumMessages) => patchDraft({ useMinimumMessages })} />
            {draft.useMinimumMessages ? <NumberField
              label={labels.messageCount}
              value={draft.minimumMessages}
              onChange={(minimumMessages) => patchDraft({ minimumMessages })}
              min={1}
              max={100_000}
              required
            /> : null}
          </> : null}
          {draft.type === "time_of_day" ? <>
            <Field label={labels.time} value={draft.time} onChange={(time) => patchDraft({ time })} placeholder="HH:MM" required />
            <div className="timer-weekdays" role="group" aria-label={labels.weekdays}>
              {labels.weekdaysNames.map((day, index) => {
                const allDays = draft.weekdays.length === 0;
                const checked = allDays || draft.weekdays.includes(index);
                return <Switch key={day} label={day} checked={checked} onChange={() => {
                  const days = allDays ? labels.weekdaysNames.map((_, dayIndex) => dayIndex).filter((dayIndex) => dayIndex !== index)
                    : checked ? draft.weekdays.filter((selected) => selected !== index) : [...draft.weekdays, index].sort();
                  patchDraft({ weekdays: days.length === 7 ? [] : days });
                }} />;
              })}
            </div>
            <Switch label={labels.alsoOffline} checked={draft.alsoOffline} onChange={(alsoOffline) => patchDraft({ alsoOffline })} />
          </> : null}
          {draft.type === "before_event" ? <>
            <Select label={labels.eventSource} value={draft.sourceId || null} onChange={(sourceId) => patchDraft({ sourceId: sourceId ?? "" })} options={sourceOptions} required />
            <NumberField label={labels.before} value={draft.minutes} onChange={(minutes) => patchDraft({ minutes })} min={1} max={1_440} unit="min" required />
          </> : null}

          {error === null ? null : <p className="form-error" role="alert">{error}</p>}
          <div className="inspector-actions">
            <Button type="submit" variant="primary" disabled={pending || blockOptions.length === 0}>{labels.save}</Button>
            <Button type="button" variant="neutral" onClick={() => { void preview(draft.blockName); }} disabled={draft.blockName.length === 0 || previewBusy}>{labels.preview}</Button>
            <Button type="button" variant="subtle" onClick={() => { setDraft(null); setEditing(null); }}>{labels.cancel}</Button>
          </div>
        </form>}
      </Dialog>

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
