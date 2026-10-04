import type { Hono } from "hono";
import type { ComponentType } from "react";
import type { z } from "zod";
import type { AuditWriteAction, ChannelRole, ChannelStreamState, ChannelVariableOperation, ChatOutputTarget, ImmediateActionRequirement } from "../contracts/values";
import type { TemplateContext, TemplateFields, TemplateVariable } from "../template";
import type { SettingsEditorDefinition } from "../dashboard/ui";
import type { ModerationResult } from "./contracts/moderation";
export type { PanelTemplateWarning, PanelTemplateWarningResponse } from "../panel-contract";
export { CHAT_OUTPUT_TARGETS } from "../contracts/values";
export type { ChatOutputTarget } from "../contracts/values";

/** The default channel timezone used by host template values and channel settings. */
export const DEFAULT_CHANNEL_TIME_ZONE = "Europe/Berlin";

/** How long overlay stream details stay cached before live viewer counts refresh. */
export const OVERLAY_STREAM_DETAILS_CACHE_TTL_MS = 60_000;

/** Maximum decoded size accepted for JSON responses from external providers. */
export const PROVIDER_JSON_MAX_BYTES = 256 * 1024;

/** Reads a provider JSON response while enforcing a decoded body size limit. */
export const readBoundedJsonResponse = async <Value = unknown>(
  response: Response,
  maximumBytes = PROVIDER_JSON_MAX_BYTES,
): Promise<Value> => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("The JSON response size limit must be a positive safe integer.");
  }
  const contentLength = response.headers.get("Content-Length");
  const declaredLength = contentLength === null ? Number.NaN : Number(contentLength);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    try { await response.body?.cancel(); } catch { /* Ignore cancellation errors after rejecting the response. */ }
    throw new Error("JSON response exceeded the size limit.");
  }
  const body = response.body;
  if (body === null) throw new Error("JSON response had no body.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
      } else {
        byteLength += chunk.value.byteLength;
        if (byteLength > maximumBytes) {
          throw new Error("JSON response exceeded the size limit.");
        }
        chunks.push(chunk.value);
      }
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Ignore cancellation errors while releasing the reader. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return payload as Value;
};

export const validChannelTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
};

// Intl.DateTimeFormat construction is far costlier than formatToParts on an existing
// instance, and the binary searches below call these dozens of times per lookup --
// formatters are immutable and safe to reuse, so cache one per time zone.
const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

const dateKeyFormatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = dateKeyFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateKeyFormatters.set(timeZone, formatter);
  }
  return formatter;
};

const localDateKeyInTimeZone = (instant: number, timeZone: string): string => {
  const parts = dateKeyFormatterFor(timeZone).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${String(values.year)}-${String(values.month)}-${String(values.day)}`;
};

/**
 * Returns the first instant (ISO string) whose local calendar date in `timeZone` is
 * `localDate`. Solves for the date boundary directly (binary search) instead of the
 * wall-clock time "00:00", which a DST change can skip (spring-forward at midnight,
 * e.g. Africa/Cairo) or repeat (fall-back at midnight) -- a fixed-point search on that
 * wall-clock time then resolves to the wrong day. Shared by every module that needs a
 * location- or channel-local midnight, so the fix lives in one place.
 */
export const localMidnightInTimeZone = (localDate: string, timeZone: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  if (match === null) throw new RangeError("Invalid local calendar date.");
  const [, yearText, monthText, dayText] = match;
  const naiveUtcMidnight = Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText));
  // Real-world UTC offsets stay within -12:00..+14:00; this margin brackets the date
  // boundary on both sides regardless of offset or DST at the boundary.
  let low = naiveUtcMidnight - 26 * 60 * 60_000;
  let high = naiveUtcMidnight + 26 * 60 * 60_000;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (localDateKeyInTimeZone(mid, timeZone) < localDate) low = mid; else high = mid;
  }
  return new Date(high).toISOString();
};

/** Returns the next local midnight strictly after `from`, as a UTC epoch instant. */
export const nextLocalMidnightInTimeZone = (from: number, timeZone: string): number => {
  const today = localDateKeyInTimeZone(from, timeZone);
  let low = from;
  let high = from + 26 * 60 * 60_000;
  for (let guard = 0; localDateKeyInTimeZone(high, timeZone) === today && guard < 3; guard += 1) high += 24 * 60 * 60_000;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (localDateKeyInTimeZone(mid, timeZone) === today) low = mid; else high = mid;
  }
  return high;
};

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

const wallClockFormatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = wallClockFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
};

/** The local wall-clock reading at `instant` in `timeZone`, expressed as if it were UTC. */
const localWallClockMillis = (instant: number, timeZone: string): number => {
  const parts = wallClockFormatterFor(timeZone).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
};

/**
 * Returns the UTC instant(s) at which the local wall-clock time in `timeZone` reads
 * `time` ("HH:MM") on `localDate`. Normally exactly one instant. A DST transition can
 * make that wall time occur twice (clocks set back, e.g. Europe/Berlin 2026-10-25
 * 02:30) -- both instants are returned, earliest first. A transition can also skip the
 * wall time entirely (clocks set forward, e.g. Africa/Cairo 2026-04-24 00:30) -- in that
 * case the single returned instant is the transition itself, since that is the instant
 * the boundary the wall time was meant to mark actually takes effect.
 */
export const wallTimeInstantsInTimeZone = (localDate: string, time: string, timeZone: string): readonly number[] => {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  const timeMatch = /^(\d{2}):(\d{2})$/u.exec(time);
  if (dateMatch === null || timeMatch === null) throw new RangeError("Invalid local date or time.");
  const [, yearText, monthText, dayText] = dateMatch;
  const [, hourText, minuteText] = timeMatch;
  const target = Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText));
  // Real-world UTC offsets stay within -12:00..+14:00 and a single DST shift is far
  // narrower than a day, so this margin brackets any transition around `target`.
  const lowBound = target - 26 * 60 * 60_000;
  const highBound = target + 26 * 60 * 60_000;
  // Intl only resolves to whole seconds, so probe on second boundaries: sampling at an
  // arbitrary millisecond would leak that sub-second remainder into the offset (it
  // reads as the previous whole second's wall clock minus the exact instant), turning
  // this offset into a false ramp instead of the step function DST actually produces.
  const offsetAt = (instant: number): number => {
    const flooredSecond = Math.floor(instant / 1000) * 1000;
    return localWallClockMillis(flooredSecond, timeZone) - flooredSecond;
  };
  const offsetLow = offsetAt(lowBound);
  const offsetHigh = offsetAt(highBound);
  if (offsetLow === offsetHigh) return [target - offsetLow];
  let low = lowBound;
  let high = highBound;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (offsetAt(mid) === offsetLow) low = mid; else high = mid;
  }
  const transition = high;
  const candidateBefore = target - offsetLow;
  const candidateAfter = target - offsetHigh;
  const instants: number[] = [];
  if (candidateBefore < transition) instants.push(candidateBefore);
  if (candidateAfter >= transition) instants.push(candidateAfter);
  return instants.length > 0 ? instants.sort((left, right) => left - right) : [transition];
};

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface ModuleOverlayElementProps {
  config: Readonly<Record<string, unknown>>;
  state: Readonly<Record<string, unknown>> | null;
  now: number;
  language?: "de" | "en";
}

export interface ModuleOverlayTemplateValue {
  available: boolean;
  /** UTC instant used by browser-rendered countdown values. */
  targetAt?: string;
  /** Ordered countdown instants may start with a past instant to represent an ongoing interval as zero. */
  targetAts?: readonly string[];
  /** UTC instant when this resolved value may change and its overlay should be refreshed. */
  nextChangeAt?: string;
}

export interface ModuleTemplateConditionTransition {
  at: string;
  values: Readonly<Record<string, string>>;
}

export interface ModuleOverlayElementContext {
  now: number;
  language: ModuleLanguage;
  channelTimeZone: () => Promise<string>;
  streamState: () => Promise<ModuleStreamState>;
  /** Latest stream start used while rendering uptime, if the lookup supplied one. */
  streamStartedAt: () => string | null;
  /** Expiration of the stream-details cache consulted during this bootstrap. */
  streamDetailsCacheExpiresAt: () => number | null;
  /** Whether a host or module lookup failed during this bootstrap. */
  hasLookupFailure: () => boolean;
  channelGameId: () => Promise<string | null>;
  renderTemplate: (text: string, mode?: ModuleTemplateRenderMode) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[]; attributions?: readonly string[] }>;
  resolveTemplateConditions: (ids: readonly string[]) => Promise<ModuleOverlayTemplateConditions>;
  resolveTemplateConditionTransitions: (
    ids: readonly string[],
    from: number,
    until: number,
  ) => Promise<readonly ModuleTemplateConditionTransition[]>;
  resolveOverlayTemplateValues: (names: readonly string[]) => Promise<Readonly<Record<string, ModuleOverlayTemplateValue>>>;
  timeDependentTemplateConditionIds: ReadonlySet<string>;
  dynamicTemplateVariableNames: ReadonlySet<string>;
  overlayTemplateVariableNames: ReadonlySet<string>;
  /** Reads only this overlay element's module ballot in the current channel. */
  readBallot: (ballotId: string) => Promise<BallotSnapshot | null>;
}

export interface ModuleOverlayTemplateConditions {
  values: Readonly<Record<string, string>>;
  attributionsByCondition: Readonly<Record<string, readonly string[]>>;
  /** UTC instant per condition id when its resolved value may change; drives the overlay refresh schedule. */
  nextChangeAt?: Readonly<Record<string, string>>;
}

export interface OverlayElementEditorProps {
  config: JsonObject;
  onChange: (config: JsonObject) => void;
  channelId?: string;
  onPreviewState?: (state: JsonObject | null) => void;
  language?: "de" | "en";
  readOnly?: boolean;
  readOnlyReason?: string;
}

export interface ModuleOverlayElementDefinition {
  kind: `${string}.${string}`;
  configVersion: number;
  defaultSize: { width: number; height: number };
  defaultConfig: JsonObject;
  editorLabel?: Readonly<Record<ModuleLanguage, string>>;
  editorAddLabel?: Readonly<Record<ModuleLanguage, string>>;
  editorModuleLabel?: Readonly<Record<ModuleLanguage, string>>;
  parseConfig: (raw: unknown) => JsonObject | null;
  /** The module initial state uses host template, condition, or channel context. */
  initialStateNeedsContext?: boolean;
  /** Module realtime message types that require the host to reload this element's state. */
  reloadStateOnModuleMessages?: readonly string[];
  /** Host state changes that cause a generic module state message for this element. */
  reloadStateOnHostEvents?: readonly ModuleOverlayHostEvent[];
  initialState?: (
    db: D1Database,
    channelId: string,
    config: JsonObject,
    context?: ModuleOverlayElementContext,
  ) => Promise<JsonObject | null>;
  load: () => Promise<{ default: ComponentType<ModuleOverlayElementProps> }>;
  editor?: () => Promise<{ default: ComponentType<OverlayElementEditorProps> }>;
}

export type ModuleOverlayHostEvent = "channel.game.changed" | "stream.state.changed" | "template.data.changed";

export { truncateTo200Chars, textFingerprintIfTruncated } from "../text";
export {
  closestTemplateVariable,
  effectiveTemplateVariables,
  invalidTemplateParameters,
  renderTemplate,
  templateFieldsWarnings,
  templateVariableNames,
  templateWarnings,
  tokenizeTemplate,
  unknownTemplateVariables,
  worstCaseTemplateLength,
  TEMPLATE_TOKEN_CANDIDATE_PATTERN,
  TEMPLATE_VARIABLE_PATTERN,
} from "../template";
export type { TemplateContext, TemplateFields, TemplateVariable, TemplateValues, TemplateWarning } from "../template";
export { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../template-variables";

/** Status of the chat-triggering person, derived from Twitch badges. */
export type ModuleChatStatus = "viewer" | "subscriber" | "vip" | "moderator" | "broadcaster";

/** Parses the deliberately narrow chat syntax shared by ballot-using modules. */
export const ballotChoiceFromMessage = (text: string, optionCount: number): number | null => {
  if (!Number.isInteger(optionCount) || optionCount < 1 || optionCount > 9) return null;
  const normalized = text.trim();
  if (!/^[1-9]$/u.test(normalized)) return null;
  const choice = Number(normalized);
  return choice <= optionCount ? choice : null;
};

/**
 * A justification for something a module did, or deliberately did not do.
 *
 * `code` is machine-readable and stable (`shoutout.suppressed`), `detail`
 * carries the numbers that explain the case. Together they answer the
 * question that today goes unanswered everywhere: "Raid detected, why was
 * there no shoutout?"
 */
/**
 * The keys a diagnostic detail may carry. Closed on purpose: the detail lands in
 * `event_log.detail_json` and the interface reads it back, so it is wire data.
 * While this was `Record<string, ...>`, German keys survived four renaming
 * passes here -- each one found by accident, because a scanner only sees the
 * shapes it was taught, and every new way of building the object slipped past
 * it. A union is seen by the compiler at every construction site, however the
 * object is assembled.
 *
 * Adding a key means adding it here, and whoever adds it sees its neighbours.
 */
export type ModuleDiagnosticDetailKey =
  | "action" | "allowed" | "arguments" | "art" | "cause" | "count" | "current"
  | "currentTier" | "missing"
  | "duration" | "endsAt" | "gifter" | "kind" | "lastAdBreakAt" | "message"
  | "messageId" | "moderator" | "moduleId" | "name" | "outcome" | "person" | "alias"
  | "reason" | "recipient" | "remainingSeconds" | "requiredTier" | "response"
  | "scheduledAt" | "scheduledFor" | "scope" | "seconds" | "source"
  | "sourceChannelId" | "startedAt" | "status" | "streamState" | "target" | "targetChannelId" | "variable"
  | "text" | "threshold" | "tier" | "triggerLogin" | "twitchMessage" | "type" | "viewers";

export interface ModuleDiagnostic {
  code: string;
  detail?: Readonly<Partial<Record<
    ModuleDiagnosticDetailKey,
    string | number | boolean | null | readonly ModuleChatStatus[]
  >>>;
}

/**
 * Undoes the `message` -> `twitchMessage` rename a producer's result
 * carries for the event-log diagnostic's sake (provenance: only genuinely
 * Twitch-sourced wording gets labelled "Twitch: ..." in the dashboard
 * popover, see `dashboard/events/model.ts`'s `eventCause`) -- for a route's
 * own JSON error response, which has always used `message` (including a
 * bare `null` for a timeout/network error, where there was never a Twitch
 * body to read one from -- `helixRequest` in `worker/twitch/helix.ts`) and
 * has to keep doing so for existing clients. Converts whenever the
 * `twitchMessage` key is present at all, not only when its value is a
 * nonempty string: a `null` still has to become `detail.message: null`,
 * not vanish and leave the key missing entirely, which previously read to
 * a client as "no diagnostic detail was even attempted" instead of "Twitch
 * gave no message". A producer's `result.detail` otherwise flows straight
 * into both the diagnostic and the response body; this is the one
 * conversion point every route that forwards `result.detail` as an error
 * response calls, instead of each route inlining its own rename.
 */
export const apiErrorDetail = (
  detail: Readonly<Record<string, string | number | boolean | null>>,
): Readonly<Record<string, string | number | boolean | null>> => {
  if (!Object.hasOwn(detail, "twitchMessage") || Object.hasOwn(detail, "message")) return detail;
  // `Object.hasOwn` above already proves the key exists -- `noUncheckedIndexedAccess`
  // still types a plain index-signature read as possibly `undefined`, so this narrows
  // back to what it actually is: one of the detail value types, `undefined` excluded.
  const twitchMessage = detail.twitchMessage as string | number | boolean | null;
  const rest: Record<string, string | number | boolean | null> = { ...detail };
  rest.message = twitchMessage;
  delete rest.twitchMessage;
  return rest;
};

/** A semantically well-named module action for the host to execute. */
export type ModuleChatDelivery = "sent" | "rejected" | "ambiguous" | "not_attempted";

export type ModuleAction =
  | {
    kind: "chat";
    text: string;
    target?: ChatOutputTarget;
    replyToMessageId?: string;
    /** Chat outputs are automated by default; direct command responses set this false. */
    automated?: boolean;
    /** Lets a module finalize a claim after the host knows the delivery outcome. */
    onDelivery?: (delivery: ModuleChatDelivery) => Promise<void>;
  }
  | { kind: "announcement"; text: string; target?: ChatOutputTarget; automated?: boolean }
  | { kind: "shoutout"; targetChannelId: string }
  | { kind: "shoutout"; targetLogin: string }
  | {
    kind: "timeout";
    userId: string;
    durationSeconds: number;
    reason: string;
    onSuccess?: Extract<ModuleAction, { kind: "chat" }>;
    onFailure?: Extract<ModuleAction, { kind: "chat" }>;
  }
  | {
    kind: "ban";
    userId: string;
    reason: string;
    onSuccess?: Extract<ModuleAction, { kind: "chat" }>;
    onFailure?: Extract<ModuleAction, { kind: "chat" }>;
  }
  | {
    kind: "overlay";
    type: string;
    elementKind: string;
    payload: Readonly<Record<string, unknown>>;
    /** Optional JSON config match resolved to overlay ids before publish. */
    recipientConfig?: { field: string; value: string };
  };

/**
 * What a module describes as the result of processing. It executes nothing
 * — per decision 0001 §13 it only describes desired actions, and only the
 * worker then executes them via Twitch, D1, or Durable Objects.
 *
 * The actions live in a shared list so their order is preserved. New
 * semantic action kinds can be added later, additively, without breaking
 * existing modules through new required fields. `diagnostics` describes the
 * business reasons for acting or not acting; the host logs executed actions
 * and their outcome.
 */
export interface ModuleResult {
  actions: readonly ModuleAction[];
  diagnostics: readonly ModuleDiagnostic[];
  /** Source labels for template values used by this result; placement is host-owned. */
  attributions?: readonly string[];
  /** Variable writes and their overlay recipients, returned by the write's D1 batch. */
  variableChanges?: readonly {
    name: string;
    value: number;
    overlayIds: readonly string[];
  }[];
}

export type ModuleActor = {
  userId: string;
  login: string;
  role: ChannelRole | null;
};

export interface ModuleMutationActor {
  userId: string;
  sessionId?: string;
}

export interface ModuleMutationAuthorization {
  sql: string;
  values: readonly (string | number | null)[];
}

export type ModuleAuditValue = string | number | boolean | null | readonly string[];

/** Business values a module has explicitly cleared for the audit. */
export type ModuleAuditSnapshot = Readonly<Record<string, ModuleAuditValue>>;

export interface ModuleAuditEntry {
  channelId: string;
  moduleId: string | null;
  action: AuditWriteAction;
  before: ModuleAuditSnapshot | null;
  after: ModuleAuditSnapshot | null;
}

/** The host prepares the audit part of the same D1 mutation. */
export type PrepareModuleAudit = (
  entry: ModuleAuditEntry,
  changedAt: string,
) => D1PreparedStatement;

/**
 * Writes an audit entry immediately, for an action with no accompanying D1
 * mutation to batch it with -- an external Twitch call (start a commercial,
 * create a clip), not a row change here. `PrepareModuleAudit` above stays
 * for the batched case.
 */
export type WriteModuleAudit = (
  entry: ModuleAuditEntry,
  changedAt: string,
) => Promise<void>;

export type AuthorizeModuleMutation = (
  channelId: string,
  actor: ModuleMutationActor,
  now: string,
) => ModuleMutationAuthorization;

export interface ActiveChatterActivity {
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Infrastructure the host gives a module for its own adapter. */
export interface ModuleExecutionContext {
  DB: D1Database;
  authorizeMutation: AuthorizeModuleMutation;
  /** Ephemeral ballot access bound to the event channel and executing module. */
  ballots: ModuleBallotAccess;
  /** Lazily resolves the connected bot identity so modules can ignore its own chat messages. */
  botUserId?: () => Promise<string | null>;
  /** Checks the channel's recent bot send history for an identity or exact text match. */
  isRecentBotMessage?: (senderId: string | null, text: string) => Promise<boolean>;
  /** True only when this EventSub notification committed a real stream-state transition. */
  streamStateTransitionAccepted?: boolean;
  streamState: () => Promise<ModuleStreamState>;
  /** Monotonic count of accepted chat messages kept in this channel object. */
  chatActivityCount: () => Promise<number>;
  /** Distinct chatters tracked in the rolling activity window when a module declares the need. */
  activeChatters: {
    count: (windowMs: number) => Promise<number>;
    seen: (userId: string) => Promise<ActiveChatterActivity | null>;
  };
  /** Lazily loads the current channel's public Helix fields and live start time. */
  channelInfo: () => Promise<ModuleChannelInfo | null>;
  /** Lazily loads only the current channel game, independently of stream details. */
  channelGameId?: () => Promise<string | null>;
  /** Lazily loads whether the caller follows the current channel. */
  followedAt: (userId: string) => Promise<ModuleFollowedAt>;
  followerTotal: () => Promise<number | null>;
  chattersTotal: () => Promise<number | null>;
  userCreatedAt: (userId: string) => Promise<string | null>;
  readChannelVariables: (names: readonly string[]) => Promise<Readonly<Record<string, number>>>;
  renderTemplate: (
    text: string,
    moduleValues: Readonly<Record<string, string | number>>,
    changed?: { name: string; value: number },
    mode?: ModuleTemplateRenderMode,
  ) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[]; attributions?: readonly string[] }>;
  prepareVariableChange: (
    channelId: string,
    change: { name: string; operation: ChannelVariableOperation; amount: number | null },
    now: string,
    claim: { commandName: string; revision: number; userId: string | null },
  ) => D1PreparedStatement;
  /** Host-provided cryptographically secure integer in [0, maximumExclusive). */
  secureRandomInteger: (maximumExclusive: number) => number;
  /** Lazily reads the channel's configured chat-template language. */
  channelLanguage: () => Promise<ModuleLanguage>;
  /** Lazily reads the channel's configured time zone for date/time and module conditions. */
  channelTimeZone: () => Promise<string>;
  /** Schedules or clears an alarm registered by this module. */
  scheduleAlarm: (handlerKey: string, alarmKey: string, deadline: number, ownerRevision?: number) => Promise<void>;
  clearAlarm: (alarmKey: string, ownerRevision?: number) => Promise<void>;
}

/** Durable storage and alarm access given to a module alarm handler. */
export interface ModuleAlarmContext {
  DB: D1Database;
  channelId: string;
  /** Ephemeral ballot access bound to this alarm's channel and module. */
  ballots: ModuleBallotAccess;
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
  /** Schedule or clear another key owned by this module and handled by this registration. */
  schedule: (key: string, deadline: number, ownerRevision?: number) => Promise<void>;
  clear: (key: string, ownerRevision?: number) => Promise<void>;
  /** Renders a host template in the channel's event context. */
  renderTemplate: (text: string, now?: number) => Promise<{ text: string; attributions?: readonly string[] }>;
  /** Sends scheduled automated output through the shared channel limit with an occurrence claim. */
  sendChat: (
    text: string,
    idempotencyKey: string,
    attributions?: readonly string[],
    stillValid?: () => Promise<boolean>,
    target?: Exclude<ChatOutputTarget, "where_asked">,
  ) => Promise<{ sent: boolean; reason: string | null; retryable: boolean }>;
  /** Monotonic count of accepted chat messages kept in this channel object. */
  chatActivityCount: () => Promise<number>;
  /** Resolves all registered module event-time sources without exposing module identity. */
  resolveEventTimes: (now: number) => Promise<readonly ResolvedModuleEventTime[]>;
  streamState: () => Promise<ModuleStreamState>;
  streamStartedAt: () => Promise<{ streamId: string | null; startedAt: string | null }>;
}

export interface ModuleEventTimeContext {
  DB: D1Database;
  channelId: string;
  now: number;
  channelTimeZone: () => Promise<string>;
  channelLocation: () => Promise<ModuleChannelLocation | null>;
}

export interface ModuleEventTimeSource {
  /** Local to the declaring module; the host adds a stable namespace. */
  id: string;
  label: Readonly<Record<ModuleLanguage, string>>;
  resolve: (context: ModuleEventTimeContext) => Promise<readonly string[]>;
}

export interface ResolvedModuleEventTime {
  id: string;
  label: Readonly<Record<ModuleLanguage, string>>;
  at: string;
}

/**
 * A module-owned alarm handler, registered once and selected by stable key.
 * Handlers must be idempotent because the host retries failures using this backoff.
 */
export interface ModuleAlarmDefinition {
  key: string;
  /** Milliseconds between retries after consecutive failures. The last delay is reused. */
  retryDelaysMs?: readonly number[];
  handle: (
    context: ModuleAlarmContext,
    alarmKey: string,
    deadline: number,
    ownerRevision?: number,
  ) => Promise<void>;
  /** Replans durable schedules after an input owned by the host or another module changes. */
  onScheduleInputsChanged?: (
    context: ModuleAlarmContext,
    reason: ModuleScheduleInputChangeReason,
  ) => Promise<void>;
}

/**
 * `activation` fires when a channel control or module activation change may
 * have left a stream-scoped schedule unarmed: the host dispatches events to
 * a module only while it is enabled and the channel is unpaused (see
 * `selectModulesForEvent`), so a `stream.online` notification received
 * while either was off never reaches the module at all.
 */
export type ModuleScheduleInputChangeReason = "event_times" | "channel_time_zone" | "activation";

export interface ModuleTemplateContentCandidate {
  name: string;
  texts: readonly string[];
}

/** A generic reason a module consumer rejects a proposed template-content edit. */
export interface ModuleTemplateContentIssue {
  reason: "input_dependent";
  consumerName: string;
}

export interface ModuleTemplateContentValidationContext {
  DB: D1Database;
  channelId: string;
  candidate: ModuleTemplateContentCandidate;
  registeredVariables: readonly ModuleRegisteredTemplateVariable[];
}

export type ModuleFollowedAt = (string & {}) | null | "unavailable";

export interface BallotSnapshot {
  counts: readonly number[];
  revision: number;
}

export type BallotOpenResult =
  | { status: "opened" }
  | { status: "busy"; moduleId: string };

export type BallotCastResult = BallotSnapshot & {
  status: "counted" | "changed" | "unchanged" | "not_open";
};

/** Ballot access already bound by the host to one channel and one module. */
export interface ModuleBallotAccess {
  open: (ballotId: string, optionCount: number, expiresAt: number) => Promise<BallotOpenResult>;
  cast: (ballotId: string, userId: string, choice: number) => Promise<BallotCastResult>;
  read: (ballotId: string) => Promise<BallotSnapshot | null>;
  close: (ballotId: string) => Promise<BallotSnapshot | null>;
}

export type ModuleStreamState = "online" | "offline" | "unknown";

export interface ModuleChannelInfo {
  title: string;
  gameName: string;
  gameId: string;
  startedAt: string | null;
  viewerCount: number;
}

/** A localized, module-owned item in the channel navigation. */
export interface ModuleNavigationEntry {
  id: string;
  label: Readonly<Record<ModuleLanguage, string>>;
  description?: Readonly<Record<ModuleLanguage, string>>;
  /** Channel pages join the shared Channel group; omitted entries stay under Modules. */
  group?: "channel" | "modules";
  /** Hide the module's main switch when this page is permanently available. */
  showMainSwitch?: boolean;
  iconKind: string;
  keywords?: readonly string[];
}

/** Path data for the module's dashboard glyph; the host renders every descriptor through the same SVG frame. */
export interface ModuleIconDescriptor {
  paths: readonly string[];
}

/** A module-owned group used to present its template variables in the dashboard. */
export interface ModuleTemplateVariableGroup {
  label: Readonly<Record<ModuleLanguage, string>>;
  icon: ModuleIconDescriptor;
  /** Stable ordering relative to host groups and other module groups. */
  order?: number;
}

/** A module-owned source of text that can contain template-variable references. */
export interface ModuleTemplateUsageSource {
  text: string;
  kind: "command" | "timer" | "overlay" | "event";
  label: string;
}

export type ModuleTemplateRenderMode = "chat" | "preview" | "overlay";

/** Host-owned channel location shared read-only with modules. */
export interface ModuleChannelLocation {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timeZone: string;
}

/** Host services available to a module while resolving its declared template values. */
export interface ModuleTemplateValueContext {
  DB: D1Database;
  channelId: string;
  templateContext: TemplateContext;
  knownTemplateVariableNames: ReadonlySet<string>;
  chatStatus: readonly ModuleChatStatus[] | null;
  mode: ModuleTemplateRenderMode;
  channelLanguage: () => Promise<ModuleLanguage>;
  streamState: () => Promise<ModuleStreamState>;
  channelInfo: () => Promise<ModuleChannelInfo | null>;
  channelGameId?: () => Promise<string | null>;
  channelTimeZone: () => Promise<string>;
  /** Lazily reads the host-owned channel location. */
  channelLocation: () => Promise<ModuleChannelLocation | null>;
  /** The public Worker origin, used by modules to reject requests back to this service. */
  publicOrigin?: string;
  /** Shared across the providers involved in a single template render. */
  externalFetchBudget?: ModuleExternalFetchBudget;
  /** Renders a module-owned nested fragment with the same host values and channel context. */
  renderTemplate: (text: string, mode?: ModuleTemplateRenderMode) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[]; attributions?: readonly string[] }>;
  addDiagnostic: (diagnostic: ModuleDiagnostic) => void;
  now: number;
  /** Resolves declared data-source conditions only when a block uses them. */
  resolveTemplateConditions: (ids: readonly string[]) => Promise<Readonly<Record<string, string>>>;
  /** Values preserved for overlay-side countdown or other browser calculations. */
  dynamicTemplateVariableNames?: ReadonlySet<string>;
  /** Command input is present only while resolving a chat-command template. */
  commandInput?: { commandName: string; arguments: string; usageText?: string };
  /** Records a source label for values used in this render; the host handles output placement. */
  addTemplateValueAttribution?: (text: string) => void;
}

export interface ModuleTemplateConditionContext {
  DB: D1Database;
  channelId: string;
  channelTimeZone: () => Promise<string>;
  /** Lazily reads the host-owned channel location. */
  channelLocation: () => Promise<ModuleChannelLocation | null>;
  /** The public Worker origin, used by modules to reject requests back to this service. */
  publicOrigin?: string;
  /** Shared across the providers involved in a single template render. */
  externalFetchBudget?: ModuleExternalFetchBudget;
  now: number;
  commandInput?: { commandName: string; arguments: string; usageText?: string };
  /** Records a source label when a condition uses values from this module. */
  addTemplateValueAttribution?: (text: string) => void;
  /** Records the UTC instant when a resolved condition value may next change, for overlay refresh scheduling. */
  addTemplateConditionNextChangeAt?: (at: string) => void;
}

export interface ModuleExternalFetchBudget {
  /** Claims one outbound HTTP request, including a redirect hop. */
  claim: () => boolean;
}

export interface ModuleTemplateConditionTimelineContext extends ModuleTemplateConditionContext {
  until: number;
}

/** A condition a module makes available to text block variants. */
export interface ModuleTextBlockConditionDefinition {
  id: string;
  label: Readonly<Record<ModuleLanguage, string>>;
  values: Readonly<Record<string, Readonly<Record<ModuleLanguage, string>>>>;
  /** The value can change with time without a server-side mutation. */
  timeDependent?: boolean;
}

export interface ModuleVariableReferenceUsage {
  moduleId: string;
  itemName: string;
  kind: "action" | "template" | "display";
  overlayId?: string;
  elementId?: string;
  elementLabel?: string;
  reconnect?: boolean;
}

export interface ModuleVariableReferences {
  usages: (db: D1Database, channelId: string, name: string) => Promise<readonly ModuleVariableReferenceUsage[]>;
  rename: (db: D1Database, channelId: string, from: string, to: string) => readonly D1PreparedStatement[];
}

export interface ModuleChannelVariable {
  name: string;
  value: number;
  description: string;
}

/** Host-backed variable access for module routes; each call is channel-scoped. */
export interface ModuleChannelVariableAccess {
  listChannelVariables: (channelId: string) => Promise<readonly ModuleChannelVariable[]>;
  findChannelVariable: (channelId: string, name: string) => Promise<ModuleChannelVariable | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Finds and rewrites channel-variable template references in module settings. */
export const settingsVariableReferences = (
  moduleId: string,
  fields: readonly string[],
): ModuleVariableReferences => ({
  async usages(db, channelId, name): Promise<readonly ModuleVariableReferenceUsage[]> {
    const row = await db.prepare(
      "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, moduleId).first<{ settings: string }>();
    if (row === null) return [];
    let settings: unknown;
    try {
      settings = JSON.parse(row.settings) as unknown;
    } catch {
      return [];
    }
    if (!isRecord(settings)) return [];
    const token = `{var.${name}}`;
    return fields.flatMap((field) => {
      const value = settings[field];
      return typeof value === "string" && value.includes(token)
        ? [{ moduleId, itemName: field, kind: "template" as const }]
        : [];
    });
  },
  rename(db, channelId, from, to) {
    const oldToken = `{var.${from}}`;
    const nextToken = `{var.${to}}`;
    return [db.prepare(
      `UPDATE channel_modules
          SET settings = replace(settings, ?, ?), revision = revision + 1
        WHERE channel_id = ? AND module_id = ? AND instr(settings, ?) > 0
          AND EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)
          AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)`,
    ).bind(oldToken, nextToken, channelId, moduleId, oldToken, channelId, to, channelId, from)];
  },
});

/** Infrastructure for one-time initial data when a module is enabled. */
export interface ModuleEnableContext {
  DB: D1Database;
  authorizeMutation: AuthorizeModuleMutation;
  /** Prepares a success-coupled audit entry for prepared initial data. */
  prepareModuleAudit?: PrepareModuleAudit;
  actor: ModuleMutationActor;
  now: string;
}

/** Shared props for lazily loaded panel views. */
export interface ModulePanelProperties {
  channelId: string;
  /** The panel language resolved by the host; optional for legacy modules. */
  language?: ModuleLanguage;
  /** May the view execute management controls? */
  canManage?: boolean;
  /** May the view execute operational controls available to every channel role? */
  canOperate?: boolean;
  /** Generic data-source conditions available to text-block editors. */
  textBlockConditions?: readonly ModuleTextBlockConditionDefinition[];
  /** Last known status of the bot's moderator role in this channel. */
  botIsModerator?: boolean | null;
  /** Called by the host when an inspector is closed. */
  onCloseInspector?: () => void;
  /** Deep-link target set by the host (Spotlight, #164) -- a module reads
   *  its own identifier out of this if it wants to pre-select something on
   *  mount (e.g. text_commands selects the command by name); most modules
   *  ignore it. */
  initialSelection?: string;
}

/** Props for one lazily loaded card in the channel's immediate-action row. */
export interface ModuleImmediateActionProperties {
  channelId: string;
  streamState?: ChannelStreamState | null;
  /** Localized by the host from the action's declared requirements and current stream state. */
  availabilityReason: string | null;
}

export interface ModuleImmediateActionDefinition {
  /** Conditions are evaluated by the host; the module remains enabled implicitly. */
  requires: readonly ImmediateActionRequirement[];
  /** Kept lazy so disabled modules add no immediate-action bytes to the panel bundle. */
  load: () => Promise<{ default: ComponentType<ModuleImmediateActionProperties> }>;
}

export type ModuleLanguage = "de" | "en";

export const MODULE_TEMPLATE_MINIMUM_TIERS = ["everyone", "subscriber", "vip", "moderator", "broadcaster"] as const;
export type ModuleTemplateMinimumTier = (typeof MODULE_TEMPLATE_MINIMUM_TIERS)[number];

/** Chat badges that meet each shared minimum tier. */
export const MODULE_TEMPLATE_TIER_CHAT_STATUSES: Readonly<Record<ModuleTemplateMinimumTier, readonly ModuleChatStatus[]>> = {
  everyone: ["viewer", "subscriber", "vip", "moderator", "broadcaster"],
  subscriber: ["subscriber", "moderator", "broadcaster"],
  vip: ["vip", "moderator", "broadcaster"],
  moderator: ["moderator", "broadcaster"],
  broadcaster: ["broadcaster"],
};

/** A variable name provided by a module for template validation. */
export interface ModuleRegisteredTemplateVariable extends TemplateVariable {
  moduleId: string;
  isTextBlock: boolean;
  description?: string;
  pickerGroup?: ModuleTemplateVariableGroup & { id: string };
}

export const browserModuleLanguage = (): ModuleLanguage => {
  const language = typeof navigator === "undefined" ? "de" : navigator.language;
  return language.toLowerCase().startsWith("de") ? "de" : "en";
};

/** HTTP method a Helix request may use; `helixRequest` sets no default body encoding beyond JSON. */
export type HelixMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Base transport-level classification `helixRequest` derives from the raw
 * response -- nothing about what a status *means* for a given endpoint (a
 * 401 is a missing scope here, a revoked moderator there). That reading
 * stays with the caller; see `worker/twitch/helix.ts`'s header comment.
 */
export type HelixErrorReason =
  | "rate_limited" | "network_error" | "timeout" | "invalid_response" | "pagination_loop"
  | `http_${string}`;

export interface HelixRequestOptions<Data = unknown> {
  method?: HelixMethod;
  url: string;
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  accessToken: string;
  clientId: string;
  /** Validates and narrows a successful response body; a mismatch reports as `invalid_response`. */
  schema?: z.ZodType<Data>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export type HelixResult<Data = unknown> =
  | { ok: true; status: number; data: Data }
  | {
    ok: false;
    status: number | null;
    reason: HelixErrorReason;
    message: string | null;
    /** Twitch's parsed error body, tolerant of a missing or non-JSON response. */
    body: Readonly<Record<string, unknown>>;
  };

export type HelixRequest = <Data = unknown>(options: HelixRequestOptions<Data>) => Promise<HelixResult<Data>>;

export interface ModuleRouteVariables {
  session: { userId: string; sessionId: string };
  channelRole: ChannelRole;
  actor: { userId: string; sessionId: string };
  authorizeMutation: AuthorizeModuleMutation;
  authorizeManagementMutation: AuthorizeModuleMutation;
  externalFetchBudget: ModuleExternalFetchBudget;
  /** Returns ballot access bound to the authorized route channel and mounted module. */
  ballots: (channelId: string) => ModuleBallotAccess;
  prepareModuleAudit: PrepareModuleAudit;
  writeModuleAudit: WriteModuleAudit;
  listChannelVariables: ModuleChannelVariableAccess["listChannelVariables"];
  findChannelVariable: ModuleChannelVariableAccess["findChannelVariable"];
  templateUsageSources: (channelId: string) => Promise<readonly ModuleTemplateUsageSource[]>;
  listRegisteredTemplateVariables: (channelId: string) => Promise<readonly ModuleRegisteredTemplateVariable[]>;
  listTextBlockConditions: (channelId: string) => Promise<readonly ModuleTextBlockConditionDefinition[]>;
  listEventTimeSources: () => readonly { id: string; label: Readonly<Record<ModuleLanguage, string>> }[];
  resolveEventTimes: (channelId: string, now: number) => Promise<readonly ResolvedModuleEventTime[]>;
  notifyScheduleInputsChanged: (channelId: string, reason: ModuleScheduleInputChangeReason) => Promise<void>;
  validateTemplateContentMutation: (
    channelId: string,
    candidate: ModuleTemplateContentCandidate,
  ) => Promise<readonly ModuleTemplateContentIssue[]>;
  resolveTextBlockConditions: (
    channelId: string,
    ids: readonly string[],
    now: number,
  ) => Promise<Readonly<Record<string, string>>>;
  publishModuleOverlayMessage: (
    channelId: string,
    moduleId: string,
    type: string,
    elementKind: string,
    payload: Readonly<Record<string, unknown>>,
    recipientConfig?: { field: string; value: string },
  ) => Promise<void>;
  publishOverlayHostEvent: (channelId: string, event: ModuleOverlayHostEvent) => Promise<void>;
  writeModuleDiagnostics: (
    db: D1Database,
    channelId: string,
    moduleId: string,
    triggerId: string,
    actorUserId: string | null,
    diagnostics: readonly ModuleDiagnostic[],
    now: string,
  ) => Promise<unknown>;
  broadcasterHasScope: (db: D1Database, channelId: string, scope: string) => Promise<boolean>;
  broadcasterScopesForChannel: (db: D1Database, channelId: string) => Promise<readonly string[]>;
  measureServerTiming: <T>(phase: "auth" | "d1" | "do" | "helix", run: () => Promise<T>) => Promise<T>;
  recordServerTiming: (phase: "auth" | "d1" | "do" | "helix", durationMs: number) => void;
  scheduleBackgroundWork: (work: Promise<unknown>) => void;
  getAppAccessToken: (environment: Env, now: string, fetcher?: typeof fetch) => Promise<string>;
  /** Thin Helix HTTP transport (issue #163); modules never talk to `api.twitch.tv` directly. */
  helixRequest: HelixRequest;
  liftModerationBan: (channelId: string, userId: string) => Promise<ModerationResult>;
}

export interface ModuleRouteEnvironment {
  Bindings: Env;
  Variables: ModuleRouteVariables;
}

/**
 * What a module learns about the triggering event. Deliberately narrow: the
 * channel comes from the verified event, not from the module, so a module
 * cannot act on a foreign channel. `triggerId` is Twitch's message ID and
 * links all rows in the event log that belong to the same trigger.
 */
export interface ModuleEvent<Settings = unknown> {
  channelId: string;
  subscriptionType: string;
  /** The variant, like the channel, comes from the EventSub subscription condition. */
  subscriptionVariant?: string;
  triggerId: string;
  payload: Readonly<Record<string, unknown>>;
  settings: Settings;
  receivedAt: string;
  /** The role comes from channel_members; `null` means not a member. */
  actor: ModuleActor | null;
  /** Events unrelated to chat carry `null` here; chat events carry all matching statuses. */
  chatStatus: readonly ModuleChatStatus[] | null;
}

export type BotModule<SettingsSchema extends z.ZodType = z.ZodType> = {
  id: string;
  panelIcon?: ModuleIconDescriptor;
  /** The module is always enabled for every released channel and cannot be disabled. */
  mandatory?: boolean;
  /** Localized explanation shown when this module cannot be disabled. */
  mandatoryReason?: Readonly<Record<ModuleLanguage, string>>;
  /**
   * The declaration the release path uses to write an enabled
   * `channel_modules` row for new channels. A channel released before the
   * module existed gets that row from a backfill migration instead. Every
   * reader treats a missing row as disabled — this flag never substitutes
   * for the row at read time.
   */
  defaultEnabled?: boolean;
  /** Tracks per-user chat activity for the current stream while this module is enabled. */
  needsActiveChatters?: boolean;
  settingsSchema: SettingsSchema;
  defaultSettings: z.output<SettingsSchema>;
  /** Template fields and variables used by both panel validation and worker rendering. */
  templateFields?: TemplateFields<z.output<SettingsSchema>>;
  /** Static declarations for variables exposed through a dynamic provider. */
  templateVariableCatalog?: readonly TemplateVariable[];
  /** Localized source group and icon for variables provided by this module. */
  templateVariableGroup?: ModuleTemplateVariableGroup;
  /** Dynamic template variables registered from module-owned data. */
  templateVariables?: (db: D1Database, channelId: string) => Promise<readonly TemplateVariable[]>;
  /** Which host catalog groups are available in this module's templates. */
  templateContext?: TemplateContext;
  /** Allows this designated provider to register bare text-block names. */
  templateVariableNamespace?: "text_blocks";
  /** Resolves only the declared names requested from the original template fragment. */
  resolveTemplateValues?: (
    names: readonly string[],
    context: ModuleTemplateValueContext,
  ) => Promise<Readonly<Record<string, string>>>;
  /** Resolves a declared parameterized value; parameters are never recursively rendered. */
  resolveTemplateParameter?: (
    name: string,
    parameter: string,
    context: ModuleTemplateValueContext,
  ) => Promise<string | null>;
  /** Bilingual generic fallback if this provider cannot resolve a declared value. */
  templateUnavailableText?: Readonly<Record<ModuleLanguage, string>>;
  /** Declares generic conditions that module-owned text blocks can select. */
  textBlockConditions?: readonly ModuleTextBlockConditionDefinition[];
  /** Channel-specific condition choices backed by module-owned data. */
  textBlockConditionsForChannel?: (
    db: D1Database,
    channelId: string,
  ) => Promise<readonly ModuleTextBlockConditionDefinition[]>;
  /** Resolves condition ids declared by this module for a single template render. */
  resolveTemplateConditions?: (
    ids: readonly string[],
    context: ModuleTemplateConditionContext,
  ) => Promise<Readonly<Record<string, string>>>;
  /** Returns value changes for time-dependent text block conditions over an interval. */
  resolveTemplateConditionTransitions?: (
    ids: readonly string[],
    context: ModuleTemplateConditionTimelineContext,
  ) => Promise<readonly ModuleTemplateConditionTransition[]>;
  /** Declares values the overlay browser formats from target instants. */
  dynamicTemplateVariableNames?: readonly string[];
  /** Resolves overlay-only availability and target instants without changing template state. */
  resolveOverlayTemplateValues?: (
    names: readonly string[],
    context: {
      DB: D1Database;
      channelId: string;
      now: number;
      channelTimeZone: () => Promise<string>;
      channelLocation: () => Promise<ModuleChannelLocation | null>;
      language: ModuleLanguage;
    },
  ) => Promise<Readonly<Record<string, ModuleOverlayTemplateValue>>>;
  /** Channel navigation entries contributed by this module. */
  navigationEntries?: readonly ModuleNavigationEntry[];
  /** Template text contributed by this module for generic library usage views. */
  templateUsageSources?: (
    db: D1Database,
    channelId: string,
  ) => Promise<readonly ModuleTemplateUsageSource[]>;
  /** Validates edits to shared template content against this module's consumers. */
  validateTemplateContent?: (
    context: ModuleTemplateContentValidationContext,
  ) => Promise<readonly ModuleTemplateContentIssue[]>;
  /** Optional references to channel variables stored in module-owned data. */
  variableReferences?: ModuleVariableReferences;
  /** Broadcaster consent the host verifies before the EventSub subscription. */
  broadcasterScopes?: readonly string[];
  eventSubTypes?: readonly string[];
  routes?: Hono<ModuleRouteEnvironment>;
  /** Overlay presentation declarations, with view and editor chunks loaded on demand. */
  overlayElements?: readonly ModuleOverlayElementDefinition[];
  /** Durable alarm handlers registered through the shared host contract. */
  alarms?: readonly ModuleAlarmDefinition[];
  /** Generic event-time sources that scheduled modules may select. */
  eventTimeSources?: readonly ModuleEventTimeSource[];
  /**
   * The business entry point. A pure function: it describes what should
   * happen and executes nothing. The host executes the actions and logs
   * their outcome; the module justifies with `diagnostics` why it acted or
   * did not act (decision 0004).
   *
   * If the function throws, this blocks neither the worker nor the other
   * modules — the error ends up as a diagnostic in the event log.
   */
  handleEvent?: (
    event: ModuleEvent<z.output<SettingsSchema>>,
    context: ModuleExecutionContext,
  ) => ModuleResult | Promise<ModuleResult>;
  /** Called before enabling to create module-specific initial data. */
  onEnable?: (
    context: ModuleEnableContext,
    channelId: string,
  ) => readonly D1PreparedStatement[] | undefined | Promise<readonly D1PreparedStatement[] | undefined>;
  // Module migrations and further action kinds join the contract once the
  // first module needs them. Command processing launched with
  // ModuleResult.
  /**
   * This view also stays deliberately lazy: a disabled module should
   * likewise cost zero bytes in the panel bundle. Do not turn this into a
   * direct import.
   */
  panel?: () => Promise<{ default: ComponentType<ModulePanelProperties> }>;
  /** Lazily loaded editor declaration for this module's settings. */
  settingsEditor?: () => Promise<{ default: SettingsEditorDefinition<z.output<SettingsSchema>> }>;
  /** Lazily loaded immediate-action card, shown only while this module is enabled. */
  immediateActions?: ModuleImmediateActionDefinition;
};
