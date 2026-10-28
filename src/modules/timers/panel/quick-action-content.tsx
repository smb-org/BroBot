import { useEffect, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { connectedRefetchInterval, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import { Select } from "../../../dashboard/ui";
import type { Timer } from "../contracts";
import { loadUpcomingTimers } from "./service";
import { timersQuickActionTexts } from "./quick-action-locale";

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
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const timerQuery = useModuleQuery(channelId, "timers", "upcoming", (signal) => loadUpcomingTimers(channelId, signal), {
    refetchInterval: connectedRefetchInterval(realtimeStatus === "connected", 5_000),
  });
  const [selectionState, setSelectionState] = useState<TimerSelectionState>({ channelId, timerId: null });

  const timers = timerQuery.data ?? null;
  const failed = timerQuery.isError;
  const availableTimers = timers === null ? [] : plannedTimers(timers);
  const selectedId = selectionState.channelId === channelId && availableTimers.some((timer) => timer.id === selectionState.timerId)
    ? selectionState.timerId
    : null;
  const ready = timers !== null && !failed && selectedId !== null;
  const readinessReason = ready
    ? null
    : timers === null
      ? texts.loading[language]
      : failed
        ? texts.loadFailed[language]
        : availableTimers.length === 0
          ? texts.noPlanned[language]
          : texts.selectionRequired[language];
  const fieldError = failed
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
      disabled={timers === null || failed || availableTimers.length === 0}
      busy={timers === null}
      required
    />
  </div>;
}
