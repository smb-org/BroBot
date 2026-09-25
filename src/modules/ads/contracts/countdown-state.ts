export type AdCountdownState = {
  nextAdAt: string | null;
  duration: number | null;
  snoozeCount: number | null;
  snoozeRefreshAt: string | null;
  serverNow: string;
};
