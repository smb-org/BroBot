import type { PanelEventChangesResponse, PanelEventEntry, PanelEventFilters, PanelEventsResponse } from "../../panel-contract";
import { EVENT_TONES, type EventTone } from "../../contracts/values";
import { eventCauseAlreadyShown, eventCauseText, eventToneEntries, formatNumber, type dashboardTexts, type EventCode, type EventDetail, type EventNumberKey } from "../locale";
import { LEGACY_REASON_CODES, LEGACY_REASON_VALUES } from "./legacy-reasons";
import { moduleName } from "../module-labels";
import { calendarDayKey } from "../ui/format-relative-time";

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

const eventToneRank = (tone: EventTone | null): number =>
  tone === "error" ? 3 : tone === "warning" ? 2 : tone === "info" ? 1 : 0;

export const eventToneFromValue = (value: string): EventTone | null =>
  EVENT_TONES.includes(value as EventTone) ? value as EventTone : null;

export interface EventCauseInfo {
  /** The localized cause, from the same catalog lookup the code's own row
   *  formatter draws on (`eventCauseText`). */
  text: string;
  /** A diagnostic message worth showing beyond `text` -- Twitch's own
   *  wording (`detail.twitchMessage`) or, failing that, a local one
   *  (`detail.message`, e.g. a caught exception's `.message`) -- when the
   *  detail carries a nonempty one that isn't already exactly `text` (that
   *  happens when `eventCauseText` itself had nothing more specific to fall
   *  back to than that same message). No row ever surfaces this literally
   *  otherwise. */
  message: string | null;
  /** Whether `message` came from Twitch's own response (`detail.
   *  twitchMessage`) rather than a local error (`detail.message`) -- only
   *  genuinely Twitch-sourced wording gets labelled "Twitch: ..."; a local
   *  message gets a neutral label instead, since it was never Twitch
   *  talking (see the ads commercial producer's `getAppAccessToken`
   *  failure, which puts its own exception text in `detail.message`). */
  messageIsFromTwitch: boolean;
}

/** The row's failure cause for the hover/focus icon -- null on any tone
 *  other than warning/error, when the diagnostic detail carries none of the
 *  usual reason/cause/message keys, or when the row's own text already
 *  shows that exact cause (`eventCauseAlreadyShown`) and there's no further
 *  message beyond it. The icon earns its place either by adding the cause
 *  the row left out, or by surfacing a message (Twitch's own, or a local
 *  one) the row never quotes verbatim. */
export const eventCause = (entry: PanelEventEntry): EventCauseInfo | null => {
  const tone = eventTone(entry.code);
  if (tone !== "warning" && tone !== "error") return null;
  const detail = eventDetail(entry.detail, entry.code);
  const text = eventCauseText(entry.code, detail);
  if (text === null) return null;
  const twitchMessage = typeof detail.twitchMessage === "string" && detail.twitchMessage.length > 0 ? detail.twitchMessage : null;
  const localMessage = typeof detail.message === "string" && detail.message.length > 0 ? detail.message : null;
  const rawMessage = twitchMessage ?? localMessage;
  const message = rawMessage !== null && rawMessage !== text ? rawMessage : null;
  if (message === null && eventCauseAlreadyShown(entry.code, detail)) return null;
  return { text, message, messageIsFromTwitch: message !== null && twitchMessage !== null };
};

export interface EventGroup {
  key: string;
  entries: PanelEventEntry[];
  representative: PanelEventEntry;
  newestEntry: PanelEventEntry;
}

export const eventGroupKey = (entry: PanelEventEntry): string =>
  typeof entry.triggerId === "string" && entry.triggerId.length > 0
    ? `trigger:${entry.triggerId}`
    : `event:${entry.eventId}`;

/** Chronological ordering, oldest first; ties break on `eventId` for a stable sort. */
export const chronological = (left: PanelEventEntry, right: PanelEventEntry): number =>
  left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);

export interface EventHead {
  entries: PanelEventEntry[];
  headCursor: number | null;
  nextCursor: string | null;
  frontier: { createdAt: string; eventId: string } | null;
  epoch: number;
}

const MAX_EVENT_CHANGE_PAGES = 5;
export const MAX_EVENT_HEAD_ENTRIES = 1000;

let nextEventHeadEpoch = 0;

const newEventHeadEpoch = (): number => {
  nextEventHeadEpoch += 1;
  return nextEventHeadEpoch;
};

export const initialHead = (page: PanelEventsResponse): EventHead => {
  const frontier = page.entries.at(-1);
  return {
    entries: page.entries,
    headCursor: Number.isSafeInteger(page.headCursor) ? page.headCursor as number : null,
    nextCursor: page.nextCursor,
    frontier: frontier === undefined ? null : { createdAt: frontier.createdAt, eventId: frontier.eventId },
    epoch: newEventHeadEpoch(),
  };
};

export const applyEventChanges = (head: EventHead, changes: PanelEventChangesResponse): EventHead => {
  const entriesById = new Map(head.entries.map((entry) => [entry.eventId, entry]));
  // ponytail: revisit this reset path if retained head memory or rendering cost becomes measurable.
  for (const entry of changes.entries) entriesById.set(entry.eventId, entry);
  return {
    ...head,
    entries: Array.from(entriesById.values()).sort((left, right) => chronological(right, left)),
    headCursor: changes.headCursor,
  };
};

export const eventFeedContinuation = (
  head: EventHead | undefined,
  historyPages: readonly PanelEventsResponse[],
): string | null => historyPages.length > 0
  ? historyPages.at(-1)?.nextCursor ?? null
  : head?.nextCursor ?? null;

export const eventFeedEntries = (
  head: EventHead | undefined,
  historyPages: readonly PanelEventsResponse[],
): PanelEventEntry[] => {
  if (head === undefined) return [];
  const entriesById = new Map<string, PanelEventEntry>();
  for (const entry of head.entries) entriesById.set(entry.eventId, entry);
  for (const page of historyPages) {
    for (const entry of page.entries) entriesById.set(entry.eventId, entry);
  }
  const frontierEntry = historyPages.at(-1)?.entries.at(-1);
  const frontier = frontierEntry === undefined
    ? head.frontier
    : { createdAt: frontierEntry.createdAt, eventId: frontierEntry.eventId };
  const continuation = eventFeedContinuation(head, historyPages);
  return Array.from(entriesById.values())
    .filter((entry) => {
      if (continuation === null || frontier === null) return true;
      const position = entry.createdAt.localeCompare(frontier.createdAt) || entry.eventId.localeCompare(frontier.eventId);
      return position >= 0;
    })
    .sort((left, right) => chronological(right, left));
};

export const isEventChangesResponse = (value: unknown, after: number): value is PanelEventChangesResponse => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Partial<PanelEventChangesResponse>;
  return Array.isArray(response.entries) && Number.isSafeInteger(response.headCursor) &&
    (response.headCursor as number) >= after && typeof response.hasMore === "boolean";
};

export interface EventHeadRefreshIo {
  fetchHead: () => Promise<PanelEventsResponse>;
  fetchChanges: (after: number, limit: number) => Promise<unknown>;
  historyHasPages: (epoch: number) => boolean;
  isFollowing: () => boolean;
}

export const refreshEventHead = async (
  current: EventHead | undefined,
  io: EventHeadRefreshIo,
): Promise<EventHead> => {
  if (current === undefined) return initialHead(await io.fetchHead());
  if (current.headCursor === null) {
    const page = await io.fetchHead();
    const refreshed = initialHead(page);
    // A moved keyset boundary needs a new history key even before a first page commits;
    // an in-flight request against the old cursor must not leave a gap in this epoch.
    const boundaryChanged = refreshed.nextCursor !== current.nextCursor ||
      refreshed.frontier?.createdAt !== current.frontier?.createdAt ||
      refreshed.frontier?.eventId !== current.frontier?.eventId;
    if (refreshed.headCursor !== null || io.historyHasPages(current.epoch) || boundaryChanged) return refreshed;
    return { ...refreshed, epoch: current.epoch };
  }

  if (current.entries.length > MAX_EVENT_HEAD_ENTRIES && io.isFollowing()) {
    return initialHead(await io.fetchHead());
  }

  let head = current;
  for (let pageIndex = 0; pageIndex < MAX_EVENT_CHANGE_PAGES; pageIndex += 1) {
    const response: unknown = await io.fetchChanges(head.headCursor as number, 100);
    if (!isEventChangesResponse(response, head.headCursor as number)) {
      return initialHead(await io.fetchHead());
    }
    head = applyEventChanges(head, response);
    if (head.entries.length > MAX_EVENT_HEAD_ENTRIES && io.isFollowing()) {
      return initialHead(await io.fetchHead());
    }
    if (!response.hasMore) return head;
  }
  return initialHead(await io.fetchHead());
};

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
    newestEntry: groupEntries.slice(1).reduce((newest, candidate) => chronological(candidate, newest) > 0 ? candidate : newest, groupEntries[0]),
  })).sort((left, right) => chronological(right.newestEntry, left.newestEntry));
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
  groups: readonly EventGroup[];
}

/** Groups event groups by their newest entry's channel-local day, newest day first. */
export const eventDayGroups = (groups: readonly EventGroup[], timeZone: string): EventDayGroup[] => {
  const days = new Map<string, EventGroup[]>();
  for (const group of [...groups].sort((left, right) => chronological(right.newestEntry, left.newestEntry))) {
    const key = calendarDayKey(group.newestEntry.createdAt, timeZone);
    const existing = days.get(key);
    if (existing === undefined) days.set(key, [group]);
    else existing.push(group);
  }
  return Array.from(days, ([key, dayGroups]) => ({ key, groups: dayGroups }));
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
  if (key === "duration" || key === "seconds" || key === "remainingSeconds") return `${formatNumber(value)} s`;
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
