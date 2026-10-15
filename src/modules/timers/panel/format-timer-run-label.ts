import { formatRelativeTime, type RelativeTimeValue } from "../../../dashboard/ui/format-relative-time";
import type { ModuleLanguage } from "../../contract";

export const formatTimerRunLabel = (
  timestamp: RelativeTimeValue,
  now: RelativeTimeValue,
  language: ModuleLanguage,
  timeZone: string,
): string => {
  const label = formatRelativeTime(timestamp, now, language, timeZone).label;
  return language === "de" ? label.replace(/^(\p{L}{2,})(?= \d{2}:\d{2}$)/u, "$1.") : label;
};
