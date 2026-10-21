import type { ReactElement } from "react";

import type { ModuleLiveTileSnapshot } from "../modules/contract";
import type { DashboardLanguage } from "./locale";
import { dashboardTexts } from "./locale";
import { Button, Icon } from "./ui";
import "./ads-live-tile.css";

export type AdsLiveSchedule = Extract<ModuleLiveTileSnapshot, { kind: "ad_schedule" }>;

type AdsTileState = "loading" | "error" | "no_schedule" | "upcoming" | "imminent" | "running" | "disabled";

const countdownFor = (nextAdAt: string, now: number): { seconds: number; text: string } | null => {
  const at = Date.parse(nextAdAt);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.ceil((at - now) / 1_000));
  return { seconds, text: `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}` };
};

export const AdsLiveTile = ({ ads, now, language, canManage, moduleActive = true, loading = false, failed = false, snoozeFeedback = null, onSnooze }: {
  ads: AdsLiveSchedule | null;
  now: number;
  language: DashboardLanguage;
  canManage: boolean;
  moduleActive?: boolean;
  loading?: boolean;
  failed?: boolean;
  snoozeFeedback?: string | null;
  onSnooze: () => void;
}): ReactElement => {
  const labels = dashboardTexts(language).liveCockpit;
  const nextUntil = ads?.nextAdAt === null || ads?.nextAdAt === undefined ? null : countdownFor(ads.nextAdAt, now);
  const runningUntil = ads?.runningBreakEndsAt == null ? null : countdownFor(ads.runningBreakEndsAt, now);
  const invalidSchedule = (ads?.nextAdAt !== null && ads?.nextAdAt !== undefined && nextUntil === null) ||
    (ads?.runningBreakEndsAt != null && runningUntil === null);
  const running = runningUntil !== null && runningUntil.seconds > 0;
  const state: AdsTileState = !moduleActive ? "disabled"
    : failed || invalidSchedule ? "error"
      : loading && ads === null ? "loading"
        : running ? "running"
          : ads?.nextAdAt == null ? "no_schedule"
            : nextUntil !== null && nextUntil.seconds <= 120 ? "imminent" : "upcoming";
  const statusLabel = state === "error" ? labels.adTileError
    : state === "loading" ? labels.adTileLoading
      : state === "disabled" ? labels.adTileDisabled
        : state === "no_schedule" ? labels.adTileNoSchedule
          : state === "imminent" ? labels.adTileImminent
            : state === "running" ? labels.adTileRunning : labels.adTileUpcoming;
  const snoozeCount = ads?.snoozeCount ?? null;
  const snoozeReason = snoozeFeedback ?? (!canManage ? dashboardTexts(language).streamManager.managerOnly
    : !moduleActive ? labels.adTileDisabled
      : ads === null ? labels.adSnoozeUnavailable
        : !ads.snoozeScopeAvailable ? labels.adTileScopeMissing
          : snoozeCount === 0 ? labels.adTileNoJokers
            : snoozeCount === null ? labels.adSnoozeUnavailable
              : ads.nextAdAt === null ? labels.adSnoozeUnavailable : "");
  const snoozeDisabled = !canManage || !moduleActive || ads === null || loading || failed || invalidSchedule ||
    !ads.snoozeScopeAvailable || snoozeCount === null || snoozeCount <= 0 || ads.nextAdAt === null;
  const details = state === "error" ? labels.adTileScheduleUnavailable
    : state === "loading" ? " "
      : state === "disabled" ? labels.adTileDisabled
        : state === "no_schedule" ? labels.adTileNoSchedule
          : state === "running" ? labels.adTileRunningDetails
          : ads?.duration === null || ads?.duration === undefined ? " " : labels.adDuration(String(ads.duration));
  const countdown = state === "running" && runningUntil !== null ? labels.adTileRunningCountdown(runningUntil.text)
    : nextUntil === null ? "—" : labels.adTileCountdown(nextUntil.text);
  const reserved = state === "error" ? labels.adTileScheduleUnavailable : " ";

  return <section className="live-cockpit-reserve live-cockpit-ads-tile" data-state={state} aria-label={labels.nextAdBreak}>
    <header className="live-cockpit-ads-tile__header">
      <h2><Icon name="ad" size={16} /> {labels.nextAdBreak}</h2>
      <span className={`live-cockpit-ads-tile__status${state === "imminent" ? " is-imminent" : state === "error" ? " is-error" : ""}`}>{statusLabel}</span>
    </header>
    <div className="live-cockpit-ads-tile__body">
      <strong className="live-cockpit-ads-tile__countdown" aria-live="polite">{countdown}</strong>
      <span className="live-cockpit-ads-tile__duration">{details}</span>
    </div>
    <div className="live-cockpit-ads-tile__footer">
      <span className="live-cockpit-ads-tile__jokers">{labels.adTileJokers(snoozeCount === null ? "—" : String(snoozeCount))}</span>
      <Button size="compact" variant="subtle" disabled={snoozeDisabled} onClick={onSnooze}>{labels.adSnooze}</Button>
    </div>
    <div className="live-cockpit-ads-tile__reason" aria-live="polite">{snoozeReason || " "}</div>
    <div className="live-cockpit-ads-tile__reserved" aria-live="polite">{reserved}</div>
  </section>;
};
