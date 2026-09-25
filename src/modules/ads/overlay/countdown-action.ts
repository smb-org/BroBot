import type { AdCountdownState } from "../contracts/countdown-state";
import type { AdsSchedule } from "../contracts";

export interface AdCountdownOverlayAction {
  kind: "overlay";
  type: "countdown";
  payload: AdCountdownState;
}

export const adCountdownStateForSchedule = (schedule: Pick<AdsSchedule, "nextAdAt" | "duration">): AdCountdownState => ({
  nextAdAt: schedule.nextAdAt,
  duration: schedule.nextAdAt === null ? null : schedule.duration,
});

export const createAdCountdownOverlayAction = (state: AdCountdownState): AdCountdownOverlayAction => ({
  kind: "overlay",
  type: "countdown",
  payload: { nextAdAt: state.nextAdAt, duration: state.duration },
});
