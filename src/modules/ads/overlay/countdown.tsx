import { useEffect, useState, type ReactElement } from "react";
import { adsCountdownLabels } from "./countdown-locale";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const formatClock = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${String(minutes)}:${remainder}`;
};

interface AdsCountdownProperties {
  config: Readonly<Record<string, unknown>>;
  state: Readonly<Record<string, unknown>> | null;
  now: number;
  language?: "de" | "en";
}

export const AdsCountdown = ({ config, state, language = "en" }: AdsCountdownProperties): ReactElement | null => {
  const serverNow = isRecord(state) && typeof state.serverNow === "string" ? Date.parse(state.serverNow) : Number.NaN;
  const [clock, setClock] = useState(() => ({
    serverNow,
    offset: Number.isFinite(serverNow) ? serverNow - performance.now() : Number.NaN,
    currentTime: Number.isFinite(serverNow) ? serverNow : 0,
  }));

  useEffect(() => {
    if (!Number.isFinite(serverNow)) return;
    const timer = window.setInterval(() => {
      const monotonicNow = performance.now();
      setClock((previous) => {
        const offset = previous.serverNow === serverNow ? previous.offset : serverNow - monotonicNow;
        return { serverNow, offset, currentTime: monotonicNow + offset };
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [serverNow]);

  const currentTime = clock.serverNow === serverNow ? clock.currentTime : serverNow;

  if (state === null || !isRecord(state)) return null;
  const nextAdAt = state.nextAdAt;
  if (typeof nextAdAt !== "string" || !Number.isFinite(Date.parse(nextAdAt)) || !Number.isFinite(serverNow)) return null;

  const nextAdAtMs = Date.parse(nextAdAt);
  const durationSeconds = isPositiveInteger(state.duration) ? state.duration : null;
  const labels = adsCountdownLabels(language);
  const remainingAdSeconds = Math.ceil((nextAdAtMs - currentTime) / 1_000);
  let mainText: string;
  if (remainingAdSeconds > 0) {
    mainText = `${labels.adIn} ${formatClock(remainingAdSeconds)}`;
  } else if (durationSeconds !== null) {
    const adEndAt = nextAdAtMs + durationSeconds * 1_000;
    const runningSeconds = Math.ceil((adEndAt - currentTime) / 1_000);
    if (runningSeconds <= 0) return null;
    mainText = `${labels.adRunning} · ${formatClock(runningSeconds)}`;
  } else {
    return null;
  }

  const lines: string[] = [];
  if (config.showSnoozeInfo === true) {
    if (typeof state.snoozeCount === "number" && Number.isSafeInteger(state.snoozeCount) && state.snoozeCount > 0) {
      lines.push(labels.snoozesLeft(state.snoozeCount));
    } else if (state.snoozeCount === 0 && typeof state.snoozeRefreshAt === "string") {
      const refreshAt = Date.parse(state.snoozeRefreshAt);
      if (Number.isFinite(refreshAt)) {
        const refreshSeconds = Math.ceil((refreshAt - currentTime) / 1_000);
        lines.push(refreshSeconds > 0
          ? `${labels.nextSnoozeIn} ${formatClock(refreshSeconds)}`
          : labels.snoozeAvailable);
      }
    }
  }

  return <span className="brobot-module-text">
    <span>{mainText}</span>
    {lines.map((line) => <span key={line}>{line}</span>)}
    {state.isSample === true ? <small>{labels.sample}</small> : null}
  </span>;
};

export default AdsCountdown;
