import type { AdCountdownState } from "../contracts/countdown-state";
import type { AdsSchedule } from "../contracts";
import { ADS_COUNTDOWN_ELEMENT_KIND } from "./kinds";

export interface AdCountdownOverlayAction {
  kind: "overlay";
  type: "countdown";
  elementKind: typeof ADS_COUNTDOWN_ELEMENT_KIND;
  payload: AdCountdownState;
}

export const adCountdownStateForSchedule = (
  schedule: Pick<AdsSchedule, "nextAdAt" | "duration" | "snoozeCount" | "snoozeRefreshAt">,
  serverNow = new Date().toISOString(),
): AdCountdownState => ({
  nextAdAt: schedule.nextAdAt,
  duration: schedule.nextAdAt === null ? null : schedule.duration,
  snoozeCount: schedule.snoozeCount,
  snoozeRefreshAt: schedule.snoozeRefreshAt,
  serverNow,
});

export const createAdCountdownOverlayAction = (state: AdCountdownState): AdCountdownOverlayAction => ({
  kind: "overlay",
  type: "countdown",
  elementKind: ADS_COUNTDOWN_ELEMENT_KIND,
  payload: {
    nextAdAt: state.nextAdAt,
    duration: state.duration,
    snoozeCount: state.snoozeCount,
    snoozeRefreshAt: state.snoozeRefreshAt,
    serverNow: state.serverNow,
  },
});
