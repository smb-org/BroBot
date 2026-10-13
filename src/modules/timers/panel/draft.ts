import { templateTextLength } from "../../../contracts/template-text-length";
import { timerTriggerSchema, type Timer, type TimerMutationInput, type TimerTrigger } from "../contracts";

interface TimerIntervalDraft {
  minutes: number | "";
  minimumMessages: number | "";
}

export interface TimerDraft {
  name: string;
  messageText: string;
  chatTarget: Timer["chatTarget"];
  type: TimerTrigger["type"];
  live: TimerIntervalDraft | null;
  offline: TimerIntervalDraft | null;
  minutes: number | "";
  time: string;
  weekdays: number[];
  alsoOffline: boolean;
  sourceId: string;
}

export const inputFromDraft = (draft: TimerDraft): TimerMutationInput | null => {
  if (draft.name.trim().length === 0 || draft.messageText.trim().length === 0 || templateTextLength(draft.messageText) > 500) return null;
  let trigger: TimerTrigger;
  if (draft.type === "interval") {
    const partFor = (part: TimerIntervalDraft | null): { minutes: number; minimumMessages?: number } | undefined => {
      if (part === null) return undefined;
      if (typeof part.minutes !== "number") return undefined;
      return { minutes: part.minutes, ...(typeof part.minimumMessages === "number" ? { minimumMessages: part.minimumMessages } : {}) };
    };
    const live = partFor(draft.live);
    const offline = partFor(draft.offline);
    if ((draft.live !== null && live === undefined) || (draft.offline !== null && offline === undefined) ||
        (live === undefined && offline === undefined)) return null;
    trigger = { type: "interval", ...(live === undefined ? {} : { live }), ...(offline === undefined ? {} : { offline }) };
  } else if (draft.type === "stream_start") {
    if (typeof draft.minutes !== "number") return null;
    trigger = { type: "stream_start", minutes: draft.minutes };
  } else if (draft.type === "time_of_day") {
    trigger = { type: "time_of_day", time: draft.time, weekdays: draft.weekdays, alsoOffline: draft.alsoOffline };
  } else {
    if (draft.sourceId.length === 0 || typeof draft.minutes !== "number") return null;
    trigger = { type: "before_event", sourceId: draft.sourceId, minutes: draft.minutes };
  }
  const parsedTrigger = timerTriggerSchema.safeParse(trigger);
  if (!parsedTrigger.success) return null;
  return { name: draft.name.trim(), messageText: draft.messageText, chatTarget: draft.chatTarget, trigger: parsedTrigger.data };
};
