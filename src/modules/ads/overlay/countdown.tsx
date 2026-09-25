import { useEffect, useState, type ReactElement } from "react";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatUnit = (value: number, singular: string, plural: string): string =>
  `${String(value)} ${value === 1 ? singular : plural}`;

interface AdsCountdownProperties {
  config: Readonly<Record<string, unknown>>;
  state: Readonly<Record<string, unknown>> | null;
  now: number;
  language?: "de" | "en";
}

export const AdsCountdown = ({ state, now, language = "en" }: AdsCountdownProperties): ReactElement | null => {
  const [currentTime, setCurrentTime] = useState(now);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  if (state === null || !isRecord(state)) return null;
  const nextAdAt = state.nextAdAt;
  const duration = state.duration;
  if (typeof nextAdAt !== "string" || !Number.isFinite(Date.parse(nextAdAt))) return null;

  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(nextAdAt) - currentTime) / 1_000));
  const durationSeconds = typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0
    ? duration
    : null;
  const german = language === "de";
  const text = remainingSeconds === 0
    ? (german ? "Jetzt Werbung" : "Ad now")
    : `${german ? "Werbung in" : "Ad in"} ${formatUnit(remainingSeconds, german ? "Sekunde" : "second", german ? "Sekunden" : "seconds")}`;
  const durationText = durationSeconds === null
    ? ""
    : ` · ${formatUnit(durationSeconds, german ? "Sekunde" : "second", german ? "Sekunden" : "seconds")}`;

  return <span className="brobot-module-text">{text}{durationText}</span>;
};

export default AdsCountdown;
