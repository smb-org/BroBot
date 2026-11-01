const wallClockMillis = (instant: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return Date.UTC(
    Number(values.get("year")),
    Number(values.get("month")) - 1,
    Number(values.get("day")),
    Number(values.get("hour")),
    Number(values.get("minute")),
    Number(values.get("second")),
  );
};

/** Converts a channel-local datetime input to an instant; nonexistent DST times are rejected. */
export const channelDateTimeToEpoch = (value: string, timeZone: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const requested = {
    year: Number(yearText), month: Number(monthText), day: Number(dayText),
    hour: Number(hourText), minute: Number(minuteText),
  };
  const local = Date.UTC(requested.year, requested.month - 1, requested.day, requested.hour, requested.minute);
  const validated = new Date(local);
  if (validated.getUTCFullYear() !== requested.year || validated.getUTCMonth() + 1 !== requested.month ||
      validated.getUTCDate() !== requested.day || requested.hour > 23 || requested.minute > 59) return null;

  try {
    const offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 3) {
      const probe = local + hours * 60 * 60_000;
      offsets.add(wallClockMillis(probe, timeZone) - probe);
    }
    const candidates = [...offsets].map((offset) => local - offset).filter((candidate) => {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(candidate));
      const values = new Map(parts.map(({ type, value: part }) => [type, Number(part)]));
      return values.get("year") === requested.year && values.get("month") === requested.month &&
        values.get("day") === requested.day && values.get("hour") === requested.hour &&
        values.get("minute") === requested.minute;
    });
    return candidates.length === 0 ? null : Math.min(...candidates);
  } catch {
    return null;
  }
};
