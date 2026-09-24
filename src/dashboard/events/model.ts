import type { PanelEventEntry, PanelEventFilters } from "../../panel-contract";
import { EVENT_TONES, type EventTone } from "../../contracts/values";
import { eventCauseAlreadyShown, eventCauseText, eventToneEntries, formatDate, formatNumber, type dashboardTexts, type EventCode, type EventDetail, type EventNumberKey } from "../locale";
import { LEGACY_REASON_CODES, LEGACY_REASON_VALUES } from "./legacy-reasons";
import { moduleName } from "../module-labels";

export const emptyEventFilter: PanelEventFilters = {
  origin: null,
  module: null,
  tone: null,
  person: null,
};

export const PERSON_FILTER_DEBOUNCE_MS = 300;

export const eventFilterIsActive = (filters: PanelEventFilters): boolean =>
  filters.origin !== null || filters.module !== null || filters.tone !== null ||
  (filters.tones?.length ?? 0) > 0 || filters.person !== null;

export const eventMetadata = (code: string) =>
  Object.hasOwn(eventToneEntries, code) ? eventToneEntries[code as EventCode] : null;

export const eventTone = (code: string): EventTone | null =>
  eventMetadata(code)?.tone ?? null;

export const eventToneRank = (tone: EventTone | null): number =>
  tone === "error" ? 3 : tone === "warning" ? 2 : tone === "info" ? 1 : 0;

export const eventToneFromValue = (value: string): EventTone | null =>
  EVENT_TONES.includes(value as EventTone) ? value as EventTone : null;

export interface EventCauseInfo {
  /** The localized cause, from the same catalog lookup the code's own row
   *  formatter draws on (`eventCauseText`). */
  text: string;
  /** Twitch's own diagnostic `message`, when the diagnostic detail carries
   *  a nonempty one that isn't already exactly `text` (that happens when
   *  `eventCauseText` itself had nothing more specific to fall back to than
   *  that same message) -- no row ever surfaces this literally otherwise. */
  twitchMessage: string | null;
}

/** The row's failure cause for the hover/focus icon -- null on any tone
 *  other than warning/error, when the diagnostic detail carries none of the
 *  usual reason/cause/message keys, or when the row's own text already
 *  shows that exact cause (`eventCauseAlreadyShown`) and Twitch supplied no
 *  further `message` beyond it. The icon earns its place either by adding
 *  the cause the row left out, or by surfacing Twitch's own wording the row
 *  never quotes verbatim. */
export const eventCause = (entry: PanelEventEntry): EventCauseInfo | null => {
  const tone = eventTone(entry.code);
  if (tone !== "warning" && tone !== "error") return null;
  const detail = eventDetail(entry.detail, entry.code);
  const text = eventCauseText(entry.code, detail);
  if (text === null) return null;
  const rawMessage = typeof detail.message === "string" && detail.message.length > 0 ? detail.message : null;
  const twitchMessage = rawMessage !== null && rawMessage !== text ? rawMessage : null;
  if (twitchMessage === null && eventCauseAlreadyShown(entry.code, detail)) return null;
  return { text, twitchMessage };
};

export interface EventGroup {
  key: string;
  entries: PanelEventEntry[];
  representative: PanelEventEntry;
}

export const eventGroupKey = (entry: PanelEventEntry): string =>
  typeof entry.triggerId === "string" && entry.triggerId.length > 0
    ? `trigger:${entry.triggerId}`
    : `event:${entry.eventId}`;

/** Chronological ordering, oldest first; ties break on `eventId` for a stable sort. */
export const chronological = (left: PanelEventEntry, right: PanelEventEntry): number =>
  left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);

export const eventGroups = (entries: readonly PanelEventEntry[]): EventGroup[] => {
  const grouped = new Map<string, [PanelEventEntry, ...PanelEventEntry[]]>();
  for (const entry of entries) {
    const key = eventGroupKey(entry);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [entry]);
    else group.push(entry);
  }
  return Array.from(grouped, ([key, groupEntries]) => ({
    key,
    entries: groupEntries,
    representative: groupEntries.slice(1).reduce((current, candidate) => {
      const currentRank = eventToneRank(eventTone(current.code));
      const candidateRank = eventToneRank(eventTone(candidate.code));
      const currentChannelEvent = current.moduleId === "channel_events";
      const candidateChannelEvent = candidate.moduleId === "channel_events";
      return candidateRank > currentRank ||
        (candidateRank === currentRank && candidateChannelEvent && !currentChannelEvent) ||
        (candidateRank === currentRank && candidateChannelEvent === currentChannelEvent &&
          (candidateChannelEvent ? candidate.createdAt > current.createdAt : candidate.createdAt < current.createdAt))
        ? candidate
        : current;
    }, groupEntries[0]),
  }));
};

export const actorLabel = (entry: PanelEventEntry, texts: ReturnType<typeof dashboardTexts>): string =>
  entry.actorDisplayName ?? (entry.actorLogin == null
    ? entry.actorUserId == null ? texts.events.automatic : entry.actorUserId
    : `@${entry.actorLogin}`);

export const moduleLabel = (entry: PanelEventEntry): string => moduleName(entry.moduleId);

const stringDetail = (detail: EventDetail, key: string): string | null => {
  const value = detail[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The person the action was done to or about -- never invented when absent. */
export const affectedPersonLabel = (detail: EventDetail): string | null => stringDetail(detail, "person");

/** The moderator who acted, when the code's detail carries one. */
export const moderatorLabel = (detail: EventDetail): string | null => stringDetail(detail, "moderator");

export interface EventDayGroup {
  key: string;
  label: string;
  groups: readonly EventGroup[];
}

/** The viewer's local calendar day, matching `formatTimestamp`'s zone. Exported for reuse by the audit log's own day grouping (`dashboard/audit/model.ts`). */
export const dayKey = (createdAt: string): string => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** Groups already-sorted event groups by day, newest day first, preserving order within a day. */
export const eventDayGroups = (groups: readonly EventGroup[]): EventDayGroup[] => {
  const days = new Map<string, EventGroup[]>();
  for (const group of groups) {
    const key = dayKey(group.representative.createdAt);
    const existing = days.get(key);
    if (existing === undefined) days.set(key, [group]);
    else existing.push(group);
  }
  return Array.from(days, ([key, dayGroups]) => ({
    key,
    label: formatDate(dayGroups[0]?.representative.createdAt ?? key),
    groups: dayGroups,
  }));
};

/** `code` scopes the legacy-value rewrite (`LEGACY_REASON_CODES`) to the
 *  handful of codes the rename actually touched -- a moderation event's
 *  free-text `reason` (or any other code's) is left exactly as stored, even
 *  if it happens to spell one of the old renamed values (see
 *  `legacy-reasons.ts` for the exact list). */
export const eventDetail = (detail: string, code: string): EventDetail => {
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return LEGACY_REASON_CODES.has(code) && typeof record.reason === "string" && Object.hasOwn(LEGACY_REASON_VALUES, record.reason)
      ? { ...record, reason: LEGACY_REASON_VALUES[record.reason] }
      : record;
  } catch {
    return {};
  }
};

export const eventChipNumber = (detail: EventDetail, key: EventNumberKey): string | null => {
  if (key === null) return null;
  const value = detail[key];
  if (key === "tier") {
    const tier = typeof value === "number" ? String(value) : value;
    if (typeof tier !== "string") return null;
    if (tier === "1000") return "T1";
    if (tier === "2000") return "T2";
    if (tier === "3000") return "T3";
    if (tier.toLowerCase() === "prime") return "Prime";
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return null;
  if (key === "count") return `${formatNumber(value)}x`;
  if (key === "duration" || key === "remainingSeconds") return `${formatNumber(value)} s`;
  return formatNumber(value);
};

/** Pretty-prints the diagnostic detail for the inspector's technical
 *  details, through the same legacy-value normalization (`eventDetail`)
 *  every other reader goes through -- otherwise a row persisted before
 *  issue #191's rename would show its old German reason here even though
 *  the row text and cause popover both show the new English one. Malformed
 *  JSON still falls back to the raw string (`JSON.parse` throwing is what
 *  distinguishes that from a legitimately empty `{}`). */
export const formatEventDetail = (detail: string, code: string): string => {
  try {
    JSON.parse(detail);
    return JSON.stringify(eventDetail(detail, code), null, 2);
  } catch {
    return detail;
  }
};
