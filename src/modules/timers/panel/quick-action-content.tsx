import { useEffect, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { Select } from "../../../dashboard/ui";
import type { Timer } from "../contracts";
import { loadUpcomingTimers } from "./service";
import { timersQuickActionTexts } from "./quick-action-locale";

interface TimerListState {
  channelId: string;
  timers: readonly Timer[] | null;
  failed: boolean;
}

interface TimerSelectionState {
  channelId: string;
  timerId: string | null;
}

const plannedTimers = (timers: readonly Timer[]): Timer[] => timers.filter((timer) =>
  timer.enabled && timer.nextRunAt !== null && Number.isFinite(Date.parse(timer.nextRunAt)));

const nextRunTime = (value: string, language: "de" | "en"): string =>
  new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));

export default function SkipTimerActionContent({ channelId, language, onReadinessChange }: ModuleImmediateActionContentProperties): ReactElement {
  const texts = timersQuickActionTexts;
  const [timerListState, setTimerListState] = useState<TimerListState>({ channelId, timers: null, failed: false });
  const [selectionState, setSelectionState] = useState<TimerSelectionState>({ channelId, timerId: null });

  useEffect(() => {
    const controller = new AbortController();
    void loadUpcomingTimers(channelId, controller.signal).then((timers) => {
      if (!controller.signal.aborted) setTimerListState({ channelId, timers, failed: false });
    }).catch(() => {
      if (!controller.signal.aborted) setTimerListState({ channelId, timers: [], failed: true });
    });
    return () => { controller.abort(); };
  }, [channelId]);

  const timers = timerListState.channelId === channelId ? timerListState.timers : null;
  const availableTimers = timers === null ? [] : plannedTimers(timers);
  const selectedId = selectionState.channelId === channelId && availableTimers.some((timer) => timer.id === selectionState.timerId)
    ? selectionState.timerId
    : null;
  const ready = timers !== null && !timerListState.failed && selectedId !== null;
  const readinessReason = ready
    ? null
    : timers === null
      ? texts.loading[language]
      : timerListState.failed
        ? texts.loadFailed[language]
        : availableTimers.length === 0
          ? texts.noPlanned[language]
          : texts.selectionRequired[language];
  const fieldError = timerListState.failed
    ? texts.loadFailed[language]
    : timers !== null && availableTimers.length === 0
      ? texts.noPlanned[language]
      : undefined;

  useEffect(() => {
    onReadinessChange?.(ready, readinessReason);
  }, [onReadinessChange, readinessReason, ready]);

  return <div className="live-action-content" aria-busy={timers === null}>
    <Select
      label={texts.timerLabel[language]}
      name="timerId"
      value={selectedId}
      onChange={(timerId) => { setSelectionState({ channelId, timerId }); }}
      options={availableTimers.map((timer) => ({
        value: timer.id,
        label: timer.name.trim() || timer.id,
        description: nextRunTime(timer.nextRunAt ?? "", language),
      }))}
      placeholder={texts.chooseTimer[language]}
      hint={texts.chooseTimerHint[language]}
      dropdownBelowField
      {...(fieldError === undefined ? {} : { error: fieldError })}
      disabled={timers === null || timerListState.failed || availableTimers.length === 0}
      busy={timers === null}
      required
    />
  </div>;
}
