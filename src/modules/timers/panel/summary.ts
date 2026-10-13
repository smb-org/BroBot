import type { Timer } from "../contracts";
import type { timersTexts } from "./locale";
import type { TimersPanelData } from "./service";

type Labels = ReturnType<typeof timersTexts>;

export const triggerDetail = (timer: Timer, data: TimersPanelData, labels: Labels, language: "de" | "en"): string => {
  const trigger = timer.trigger;
  if (trigger.type === "interval") {
    const describe = (state: "live" | "offline", part: typeof trigger.live): string => {
      if (part === undefined) return state === "offline" ? labels.offlineOff : labels.liveOff;
      const threshold = part.minimumMessages === undefined ? "" : ` · ${labels.afterMessages(part.minimumMessages)}`;
      return `${(state === "live" ? labels.liveEvery : labels.offlineEvery)(part.minutes)}${threshold}`;
    };
    return `${describe("live", trigger.live)} · ${describe("offline", trigger.offline)}`;
  }
  if (trigger.type === "stream_start") return `${String(trigger.minutes)} ${labels.minutesUnit}`;
  if (trigger.type === "time_of_day") {
    const selectedDays = trigger.weekdays.length === 0 ? labels.everyDay : trigger.weekdays.map((day) => labels.weekdaysNames[day]).join(", ");
    return `${trigger.time} · ${selectedDays}${trigger.alsoOffline ? ` · ${labels.alsoOffline}` : ""}`;
  }
  const label = data.sources.find((source) => source.id === trigger.sourceId)?.label[language] ?? trigger.sourceId;
  return `${labels.minutesBeforeEvent(trigger.minutes)} · ${label}`;
};

export const nextRunLabel = (timer: Pick<Timer, "nextRunState">, labels: Labels): string => {
  if (timer.nextRunState === "live") return labels.nextRunLive;
  if (timer.nextRunState === "offline") return labels.nextRunOffline;
  return labels.nextRun;
};
