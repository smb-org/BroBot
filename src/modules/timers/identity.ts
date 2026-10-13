import type { ModuleAlarmIdentity } from "../contract";
import type { Timer } from "./contracts";

export const timerAlarmIdentity = (
  timer: Timer,
  deadline: number,
  state: Timer["nextRunState"],
  streamId: string | null,
  generation: number | null,
): ModuleAlarmIdentity => ({
  timerId: timer.id,
  revision: timer.revision,
  triggerType: timer.trigger.type,
  state,
  streamId,
  generation,
  deadline,
});

export const sameTimerAlarmIdentity = (
  left: ModuleAlarmIdentity | null | undefined,
  right: ModuleAlarmIdentity | null | undefined,
): boolean => left !== undefined && left !== null && right !== undefined && right !== null &&
  left.timerId === right.timerId && left.revision === right.revision && left.triggerType === right.triggerType &&
  left.state === right.state && left.streamId === right.streamId && left.generation === right.generation &&
  left.deadline === right.deadline;

export interface TimerAlarmFence {
  identity?: ModuleAlarmIdentity | null;
  planSequence?: number;
  cleared?: boolean;
}

export const acceptsTimerAlarmSet = (
  current: TimerAlarmFence | undefined,
  identity: ModuleAlarmIdentity,
  planSequence: number,
): boolean => {
  const currentSequence = current?.planSequence ?? -1;
  return currentSequence < planSequence ||
    (currentSequence === planSequence && current !== undefined && current.cleared !== true &&
      sameTimerAlarmIdentity(current.identity, identity));
};

export const acceptsTimerAlarmClear = (
  current: TimerAlarmFence | undefined,
  expectedIdentity: ModuleAlarmIdentity | null | undefined,
  planSequence: number,
): boolean => {
  const currentSequence = current?.planSequence ?? -1;
  return currentSequence < planSequence ||
    (currentSequence === planSequence && current !== undefined && (current.cleared === true ||
      sameTimerAlarmIdentity(current.identity, expectedIdentity)));
};
