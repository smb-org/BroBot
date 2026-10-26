import { writeModuleAudit } from "../module-audit";
import { DurableObject } from "cloudflare:workers";

import type {
  RealtimeEnvelope,
  RealtimeMessage,
  RealtimePrincipal,
  RealtimeRecipientKind,
} from "../../realtime-contract";
import {
  OVERLAY_ACCESS_BOUND_CLOSE_CODE,
  OVERLAY_ACCESS_BOUND_CLOSE_REASON,
  isModuleOverlayRealtimeEnvelope,
  realtimeRecipients,
} from "../../realtime-contract";
import { CHANNEL_ROLES, type ChannelRole } from "../../contracts/values";
import { processAdPrewarning } from "../ad-prewarning";
import {
  claimTestMessageSend as claimTestMessageSendInStorage,
  releaseTestMessageSend as releaseTestMessageSendInStorage,
} from "./test-message-rate-limit";
import { REALTIME_PRINCIPAL_HEADER, REALTIME_PROTOCOL } from "../realtime-protocol";
import type { AdsSchedule } from "../../modules/ads/contracts";
import type { ClipsSettings } from "../../modules/clips/contracts";
import {
  alarmKeyFor as timerAlarmKeyFor,
  eventTimeRefreshKeyFor,
  intervalPartFor,
  isDailyTimerDeadlineCurrent,
  timerOccurrenceKey,
  triggerDelayMs,
} from "../../modules/timers/domain";
import {
  emptyDurableTimerState,
  makeTimerPlan,
  sameStreamStartedAt,
  sameTimerScheduledOccurrence,
  sameTimerOccurrence,
  TIMER_ALARM_PREFIX,
  TIMER_ACTIVITY_COUNTS_KEY,
  TIMER_DURABLE_STATE_KEY,
  TIMER_OCCURRENCE_HANDLER,
  type DurableTimerConfig,
  type DurableTimerEntry,
  type DurableTimerState,
  type DurableTimerStream,
  type TimerOccurrence,
  type TimerPlan,
  type TimerSkipAuditIntent,
  type TimerScheduleInputs,
  TIMER_OCCURRENCE_GRACE_MS,
} from "../../modules/timers/durable";
import { sameTimerAlarmIdentity } from "../../modules/timers/identity";
import { acceptsTimerAlarmClear, acceptsTimerAlarmSet } from "../../modules/timers/identity";
import { authorizeModuleMutation } from "../module-authorization";
import type { ActorContext } from "../db/guards";
import type { TimerIntervalState } from "../../modules/timers/contracts";
import type { SkipTimerOccurrenceResult } from "../../modules/timers/contracts";
import { mapTimerRow, type TimerRow } from "../../modules/timers/service";
import { CHAT_VOTING_ALARM_HANDLER, CHAT_VOTING_MODULE_ID } from "../../modules/chat_voting/contracts";
import { reconcileLegacyChatVoteResultDeliveries as reconcileLegacyChatVoteResultDeliveriesInD1 } from "../../modules/chat_voting/result-delivery-reconciliation";
import { OVERLAY_STREAM_DETAILS_CACHE_TTL_MS } from "../../modules/contract";
import type {
  ActiveChatterActivity,
  BallotCastResult,
  BallotFinalizeResult,
  BallotFinalizeRule,
  BallotOpenResult,
  BallotSnapshot,
  BallotTermFilter,
  BotModule,
  HelixRequest,
  HelixRequestOptions,
  ModuleAlarmContext,
  ModuleAlarmDefinition,
  ModuleAlarmIdentity,
  ModuleAlarmPlan,
  ModuleAction,
  ModuleBallotAccess,
  ModuleChatDelivery,
  ModuleDryRunBallotSnapshot,
  ModuleExternalFetchBudget,
  ModulePointsAccess,
  ModulePointRoundAnnouncement,
  ModulePointRoundResult,
  ModuleScheduleInputChangeReason,
  ModuleStatisticsClipImport,
  ModuleStatisticsStreamState,
  ModuleStatisticsWordCount,
  ModuleStatisticsWordBucket,
  ModuleStatisticsWindow,
  ModuleTimelineEvent,
  PointActiveRound,
  PointJoinResult,
  PointRoundAnswerResult,
  PointRoundParticipants,
  PointSettlementCooldown,
  PointsApplyResult,
  PointsKind,
  PointsMovement,
} from "../../modules/contract";
import {
  admitStatisticsWordCounts,
  STATISTICS_WORD_STREAM_IDLE_MILLISECONDS,
  STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS,
  STATISTICS_WINDOW_MILLISECONDS,
  statisticsWindowStartMs,
  tokenizeStatisticsWords,
  type StatisticsChatActivity,
} from "../../modules/statistics/domain";
import {
  EVENTSUB_REPLAY_WINDOW_MILLISECONDS,
  EVENTSUB_TIMESTAMP_SKEW_TOLERANCE_MILLISECONDS,
} from "../eventsub-constants";
import { MODULES } from "../../modules/registry";
import {
  ACTIVE_CHATTER_EXPIRY_HANDLER,
  AD_COUNTDOWN_REFRESH_HANDLER,
  AD_PREWARNING_HANDLER,
  CLIP_JOB_ALARM_HANDLER,
  CHANNEL_HOST_ALARM_HANDLER_KEYS,
  MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER,
  SECURITY_RETRY_HANDLER,
  SECURITY_ROUND_HANDLER,
  missingAlarmHandlerKeys,
  moduleAlarmHandlerEntries,
} from "./module-alarm-registry";
import { getAdSchedule } from "../../modules/ads/adapters/ad-schedule";
import { writeAdCountdownState } from "../../modules/ads/adapters/countdown-state";
import { adCountdownStateForSchedule, createAdCountdownOverlayAction } from "../../modules/ads/overlay/countdown-action";
import { refreshAdPrewarningAlarm } from "../../modules/ads/adapters/prewarning-alarm";
import type { AdPrewarningScheduler } from "../../modules/ads/adapters/prewarning-alarm";
import { getAppAccessToken } from "../app-token";
import { broadcasterHasScope } from "../broadcaster-scope";
import { helixRequest } from "../twitch/helix";
import { fetchLiveChattersTotal, fetchLiveViewerCount } from "../twitch/aggregate-counts";
import { fetchStreamClips as fetchTwitchStreamClips } from "../twitch/stream-clips";
import { TWITCH_RATE_LIMIT_COOLDOWN_MS } from "../twitch/rate-limit";
import { prepareModuleOverlayRealtimeMessage } from "../module-overlay-realtime";
import {
  notifyCommittedResources,
  panelResourceChangedMessage,
  readPanelResourceRevisions,
  type PanelResourceRevisionVector,
  withCommittedPanelResourceDrain,
} from "../panel-resources";
import { createModuleSecretAccess } from "../module-secrets";
import { sendChatMessage } from "../chat";
import { sendModerationBan } from "../moderation";
import { readChannelStreamState } from "../db/stream-state";
import { writeChannelTimelineEvent, writeChannelTimelineEventOrThrow } from "../db/timeline-events";
import { readChannelDefaultChatTarget } from "../db/channel-settings";
import { moduleEnabledForChannel, readDispatchChannelState } from "../db/channel-controls";
import { chatOutputSuppressionReason } from "../chat-output-gate";
import { resolveModuleEventTimes } from "../module-event-times";
import { renderScheduledTemplate } from "../scheduled-template-renderer";
import { secureRandomInteger } from "../template-resolver";
import { createModuleExternalFetchBudget } from "../external-fetch-budget";
import { templateLanguageText } from "../../modules/template-language";
import { writeModuleDiagnostics } from "../event-log";
import {
  confirmChannelClipAvailability,
  postConfirmedClipLink,
  requestChannelClipCreation,
  type ClipCreationResult,
  type CreateClipResult,
} from "../clip";
import {
  claimModuleAlarmSend,
  finishModuleAlarmSend,
  readModuleAlarmSendClaim,
} from "./module-alarm-send-claims";
import {
  claimAutomatedChatOutput,
  isRecentBotChatMessage,
  recordRecentBotChatMessage,
} from "./automated-chat-output";
import {
  BALLOT_EXPIRY_ALARM_HANDLER,
  BALLOT_HARD_DELETE_ALARM_HANDLER,
  approveStoredBallotTerm,
  ballotExpiryAlarmKey,
  ballotIdentityFromExpiryAlarmKey,
  castStoredBallot,
  castStoredBallotTerm,
  closeStoredBallot,
  forgetClosedStoredBallot,
  expireStoredBallot,
  finalizeStoredBallot,
  hasOpenStoredBallot,
  hasOpenStoredBallotSnapshot,
  hardDeleteFinalizedStoredBallot,
  openStoredBallot,
  readStoredBallot,
  readStoredBallotDryRunSnapshot,
  readStoredBallotSnapshot,
  setStoredBallotBlockedTerms,
} from "./ballots";
import {
  POINTS_ANNOUNCE_AMBIGUOUS_MS,
  POINTS_ANNOUNCE_MAX_ATTEMPTS,
  POINTS_ANNOUNCE_RETRY_MS,
  POINTS_CANCELLATION_NOTICE_ALARM_HANDLER,
  POINTS_CANCELLATION_NOTICE_ALARM_PREFIX,
  POINTS_ROUND_ALARM_HANDLER,
  POINTS_ROUND_ALARM_PREFIX,
  acknowledgeWelcomeSync,
  announceAttemptSync,
  answerPointRoundSync,
  attackPointRoundSync,
  beginPointRoundResolutionDeliverySync,
  applyPointOperationSync,
  canonicalPointResult,
  assertPointAccountId,
  assertPointRoundId,
  cancelPointRoundsSync,
  claimPointCooldownSync,
  completePointRoundCancellationNoticeSync,
  creditPointActivitySync,
  ensurePointsSchema,
  acceptPointRoundSync,
  joinPointRoundSync,
  pointRoundParticipantsSync,
  listOpenPointRoundsSync,
  listPointAccounts,
  markPointRoundAnnouncedSync,
  openPointRoundSync,
  openPointRoundWithStakeSync,
  pendingPointAudits,
  pointAccount,
  pointAuditWrittenSync,
  pointBalance,
  pointHistory,
  pointPayloadHash,
  pointCooldownRemainingSync,
  settlePointOperationSync,
  pointRankOf,
  pointRanking,
  pointRoundAlarmKey,
  pointRoundDeliveryGateIsCurrentSync,
  pointRoundResolutionDeliverySync,
  pointRoundRefundRequests,
  pointRoundRow,
  pendingPointRoundCancellations,
  pendingPointRoundCancellationNotices,
  pointSummary,
  recoverablePointRounds,
  recordPointAnnouncementSync,
  recordPointRoundResolutionPreparationFailureSync,
  recordPointRoundResolutionDeliverySync,
  resolvePointRoundSync,
  settlementFromRoundData,
  setGameModuleGateSync,
  touchPointAccountSync,
} from "./points";
import { INSTANT_SETTLEMENTS, POINT_SETTLEMENTS } from "./point-settlements";
import { appendPointWelcome, POINT_WELCOME_ROUND_DATA_KEY, type PendingPointWelcome, type PointWelcomeNote } from "../point-welcome";

type PointRoundChatResult = Awaited<ReturnType<ModuleAlarmContext["sendChat"]>>;
type PointRoundDeliveryOutcome = "rate_limited" | "failed" | "delivered" | "ambiguous";

const pointRoundDeliveryOutcome = (delivery: PointRoundChatResult): PointRoundDeliveryOutcome => {
  if (delivery.sent || delivery.delivery === "delivered") return "delivered";
  if (delivery.delivery === "ambiguous") return "ambiguous";
  if (delivery.delivery === "rate_limited" || (delivery.delivery === "not_attempted" && delivery.retryable)) {
    return "rate_limited";
  }
  return "failed";
};

const pointWelcomeDelivery = (delivery: PointRoundChatResult): ModuleChatDelivery => {
  if (pointRoundDeliveryOutcome(delivery) === "delivered") return "sent";
  if (delivery.delivery === "ambiguous") return "ambiguous";
  if (delivery.delivery === "not_attempted") return "not_attempted";
  return "rejected";
};

const SECURITY_ALARM_INTERVAL_MS = 15 * 60 * 1000;
const SECURITY_RETRY_INTERVAL_MS = 60 * 1000;
const OVERLAY_HANDSHAKE_WINDOW_MS = 60 * 1000;
const OVERLAY_REVOKED_MARKER_TTL_MS = 10 * 60 * 1000;
const MAX_OVERLAY_HANDSHAKES_PER_TOKEN = 30;
const MAX_OVERLAY_SOCKETS_PER_TOKEN = 10;
const MAX_PANEL_SOCKETS_PER_USER = 10;
const MAX_CHANNEL_SOCKETS = 512;
// Keep a quarter of the room available to panel connections even when overlay
// tokens are being used at their limit.
const MAX_OVERLAY_SOCKETS_PER_CHANNEL = 384;
const D1_IN_PARAMETER_LIMIT = 100;
const FIXED_D1_PARAMETER_COUNT = 2;
const D1_IDS_PER_QUERY = D1_IN_PARAMETER_LIMIT - FIXED_D1_PARAMETER_COUNT;
const ALARM_TABLE_KEY = "channel:alarm_schedule";
const CLIP_JOB_ALARM_KEY = "clip_jobs";
const CLIP_JOB_STORAGE_PREFIX = "clip:job:";
const CLIP_JOB_LAST_PRUNED_KEY = "clip:jobs_pruned_at";
const CLIP_JOB_MAX_ATTEMPTS = 3;
const CLIP_JOB_RETRY_DELAYS_MS = [5_000, 15_000] as const;
const CLIP_JOB_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CLIP_JOB_PRUNE_INTERVAL_MS = 60 * 60_000;
const POINTS_ACTIVATION_RECONCILIATION_ALARM_KEY = "points:activation_reconciliation";
const POINTS_ACTIVATION_RECONCILIATION_ALARM_HANDLER = "host:points_activation_reconciliation";
const POINTS_ACTIVATION_RECONCILIATION_MODULES_KEY = "points:activation_reconciliation_modules";
const PANEL_DURABLE_REVISIONS_KEY = "channel:panel_resource_revisions";
const CHAT_ACTIVITY_COUNT_KEY = "channel:chat_activity_count";
const TIMER_MIRROR_RETRY_DELAY_MS = 5_000;
const MAX_TIMER_SKIP_PREPARATION_ATTEMPTS = 3;
type TimerSkipOperationOutcome = {
  result: SkipTimerOccurrenceResult;
  mirrorChanged: boolean;
  auditOperationId: string | null;
};
const POINTS_ANNOUNCEMENT_REGISTRATION: ModuleAlarmDefinition = {
  key: "points_announce",
  retryDelaysMs: [POINTS_ANNOUNCE_RETRY_MS],
  handle: () => Promise.resolve(),
};
const pointCancellationNoticeAlarmKey = (moduleId: string, revision: number): string =>
  `${POINTS_CANCELLATION_NOTICE_ALARM_PREFIX}${encodeURIComponent(moduleId)}:${String(revision)}`;
const TIMER_TOMBSTONE_RETENTION_MS = 24 * 60 * 60_000;
const MODULE_ALARM_SEND_CLAIMS_KEY = "module_alarm:send_claims";
const LEGACY_TIMER_CLAIMS_IMPORTED_KEY = "timers:legacy_claims_imported";

const streamStartIdempotencyKey = (timerId: string, streamId: string): string =>
  `${timerId}:stream_start:${encodeURIComponent(streamId)}`;
const isStreamStartTimerSkipReceipt = (timerId: string, occurrenceKey: string): boolean =>
  occurrenceKey.startsWith(`${timerId}:stream_start:`);
const timerSkipReceiptKey = (occurrence: TimerOccurrence): string => occurrence.identity.triggerType === "stream_start" &&
  occurrence.identity.streamId !== null
  ? streamStartIdempotencyKey(occurrence.identity.timerId, occurrence.identity.streamId)
  : timerOccurrenceKey(occurrence.identity.timerId, occurrence.identity.deadline, occurrence.identity.streamId ?? undefined);
const TIMER_SKIP_RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
const timerSkipReceiptsForSchedule = (
  entry: DurableTimerEntry,
  now: number,
  stream: DurableTimerStream,
): NonNullable<DurableTimerEntry["skipReceipts"]> => {
  const currentOccurrences = [entry.plannedOccurrence, entry.inFlightClaim?.occurrence];
  const activeReceiptKeys = new Set(currentOccurrences
    .filter((occurrence): occurrence is TimerOccurrence => occurrence !== null && occurrence !== undefined)
    .filter((occurrence) => occurrence.identity.triggerType !== "stream_start" || stream.state === "unknown" ||
      stream.state === "online" && stream.streamId === occurrence.identity.streamId &&
      stream.generation === occurrence.identity.generation)
    .map(timerSkipReceiptKey));
  const endedStreamStartReceiptKeys = new Set(currentOccurrences
    .filter((occurrence): occurrence is TimerOccurrence => occurrence !== null && occurrence !== undefined)
    .filter((occurrence) => occurrence.identity.triggerType === "stream_start" && stream.state !== "unknown" &&
      (stream.state !== "online" || stream.streamId !== occurrence.identity.streamId ||
        stream.generation !== occurrence.identity.generation))
    .map(timerSkipReceiptKey));
  return (entry.skipReceipts ?? []).filter((receipt) => {
    if (endedStreamStartReceiptKeys.has(receipt.occurrenceKey)) return false;
    if (isStreamStartTimerSkipReceipt(entry.config.id, receipt.occurrenceKey)) {
      return stream.state === "unknown" || stream.state === "online" && stream.streamId !== null &&
        receipt.occurrenceKey === streamStartIdempotencyKey(entry.config.id, stream.streamId);
    }
    return activeReceiptKeys.has(receipt.occurrenceKey) ||
      receipt.deadline + TIMER_SKIP_RECEIPT_RETENTION_MS >= now;
  });
};
const LEGACY_ACTIVE_CHATTER_STREAM_KEY = "chatter:stream";
const ACTIVE_CHATTER_TABLE = "active_chatters";
const STATISTICS_CHAT_WINDOW_TABLE = "statistics_chat_windows";
const STATISTICS_WORD_STREAM_TABLE = "statistics_word_streams";
const STATISTICS_CLIP_IMPORT_TABLE = "statistics_clip_imports";
const STATISTICS_WORD_COUNT_TABLE = "statistics_word_counts";
const STATISTICS_WORD_SEEN_TABLE = "statistics_word_seen";
const STATISTICS_WINDOW_RETENTION_MS = 60 * 60 * 1_000;
const EVENTSUB_MESSAGE_ID_TABLE = "eventsub_message_ids";
const EVENTSUB_MESSAGE_ID_RETENTION_MS = EVENTSUB_REPLAY_WINDOW_MILLISECONDS + 2 * EVENTSUB_TIMESTAMP_SKEW_TOLERANCE_MILLISECONDS;
const ACTIVE_CHATTER_KEY_TABLE = "active_chatter_key";
const ACTIVE_CHATTER_EXPIRY_KEY = "host:active_chatters_expiry";
const ACTIVE_CHATTER_RETENTION_MS = 60 * 60 * 1_000;
const ACTIVE_CHATTER_KEY_ROTATION_MS = 24 * 60 * 60 * 1_000;
const MODULE_ALARM_OWNER_REVISIONS_KEY = "module_alarm:owner_revisions";
const MODULE_ALARM_OWNER_REVISION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MODULE_ALARM_STREAM_GENERATIONS_KEY = "module_alarm:stream_generations";
const MODULE_ALARM_PLAN_SEQUENCES_KEY = "module_alarm:plan_sequences";
const MODULE_ALARM_PLAN_SEQUENCE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const isTimerOccurrenceAlarmKey = (key: string): boolean =>
  key.startsWith("module:timers:timer:") && !key.includes(":refresh:");
const SECURITY_DEADLINE_KEY = "security_round";
const SECURITY_RETRY_KEY = "security_retry";
const AD_PREWARNING_DEADLINE_KEY = "ad_prewarning";
const AD_PREWARNING_SEND_CLAIM_KEY = "ads:prewarning_send_claim";
const AD_SCHEDULE_CACHE_KEY = "ads:schedule";
const AD_SCHEDULE_GENERATION_KEY = "ads:schedule_generation";
const AD_PREWARNING_RECONCILED_KEY = "ads:prewarning_reconciled";
const TWITCH_RETRY_AFTER_KEY = "twitch:retry_after";
const AD_COUNTDOWN_REFRESH_ATTEMPT_KEY = "ads:countdown_refresh_attempt";
const AD_COUNTDOWN_REFRESH_DEADLINE_KEY = "ads:countdown_refresh_deadline";
const AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY = "ads:countdown_refresh_retry_count";
const PANEL_PUBLISHED_REVISIONS_KEY = "panel:published_resource_revisions";
const OVERLAY_STREAM_DETAILS_CACHE_KEY = "overlay:stream_details";
const CHANNEL_GAME_ID_CACHE_KEY = "channel:game_id";
// A failed lookup retries almost immediately instead of sitting on the full
// TTL below: an outage should not silently mean "no game" to every game
// filter for a minute.
const CHANNEL_GAME_ID_FAILURE_CACHE_TTL_MS = 5_000;
const AD_SCHEDULE_REFRESH_TIMEOUT_MS = 15_000;
const AD_COUNTDOWN_SCHEDULE_TTL_MS = 60_000;

const bumpDurablePanelResources = async (
  transaction: Pick<DurableObjectTransaction, "get" | "put">,
  resources: readonly string[],
): Promise<void> => {
  const revisions = await transaction.get<PanelResourceRevisionVector>(PANEL_DURABLE_REVISIONS_KEY) ?? {};
  const next = { ...revisions };
  for (const resource of new Set(resources)) next[resource] = (next[resource] ?? 0) + 1;
  await transaction.put(PANEL_DURABLE_REVISIONS_KEY, next);
};
const AD_COUNTDOWN_REFRESH_BUFFER_MS = 30_000;
const AD_COUNTDOWN_REFRESH_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
const ALARM_HANDLER_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
// The default 60s backoff above would itself burn through the (typically 60s)
// prewarning lead time on a single retry. A short delay here still lets a
// transient identity/token failure recover in time; `decideAdPrewarning`'s
// `too_late` check (see ad-prewarning.ts) is what actually bounds retries
// once the ad has started, not attempt count.
const AD_PREWARNING_RETRY_DELAYS_MS = [5_000, 10_000] as const;
// Send claims are kept per occurrence (keyed by its due-at ms) rather than
// deleted on clear, so a clear+re-arm of the same occurrence cannot send a
// second warning. Pruning anything older than this bounds that map's size
// across the channel's lifetime instead of retaining every occurrence ever
// claimed.
const AD_PREWARNING_CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;
const ALARM_HANDLER_RECOVERY_DELAY_MS = 60_000;
const MODULE_SCHEDULE_INPUTS_CHANGED_KEY = "host:schedule_inputs_changed";
const LEGACY_ALARM_DEFINITIONS = [
  { key: SECURITY_DEADLINE_KEY, handler: SECURITY_ROUND_HANDLER, suppressedBy: SECURITY_RETRY_KEY },
  { key: SECURITY_RETRY_KEY, handler: SECURITY_RETRY_HANDLER },
  { key: AD_PREWARNING_DEADLINE_KEY, handler: AD_PREWARNING_HANDLER },
  { key: AD_COUNTDOWN_REFRESH_DEADLINE_KEY, handler: AD_COUNTDOWN_REFRESH_HANDLER },
] as const;
const STREAM_REFRESH_LEASE_KEY = "stream_state_refresh_lease";
const STREAM_REFRESH_LEASE_MS = 30_000;
const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;
const SOCKET_TRANSIENT_CODE = 4008;
const SOCKET_POLICY_VIOLATION_CODE = 1008;

/** Drops occurrences older than the retention window from a prewarning send-claim map. */
const prunePrewarningClaims = (
  claims: Readonly<Record<string, number>>,
  now: number,
): Record<string, number> => {
  const pruned: Record<string, number> = {};
  for (const [key, dueAtMs] of Object.entries(claims)) {
    if (Number.isFinite(dueAtMs) && now - dueAtMs <= AD_PREWARNING_CLAIM_RETENTION_MS) pruned[key] = dueAtMs;
  }
  return pruned;
};

const adCountdownRefreshAt = (schedule: AdsSchedule): number | null => {
  if (schedule.nextAdAt === null || typeof schedule.duration !== "number" ||
      !Number.isFinite(schedule.duration) || schedule.duration < 0) return null;
  const nextAdAt = Date.parse(schedule.nextAdAt);
  return Number.isFinite(nextAdAt)
    ? nextAdAt + schedule.duration * 1_000 + AD_COUNTDOWN_REFRESH_BUFFER_MS
    : null;
};

export interface CachedAdSchedule {
  schedule: AdsSchedule;
  asOf: string;
}

export interface AdScheduleRefreshResult {
  cache: CachedAdSchedule | null;
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
  d1Ms: number;
  helixMs: number;
  changed: boolean;
}

interface StreamRefreshLease {
  token: string;
  expiresAt: number;
}

interface OverlayStreamDetails {
  startedAt: string | null;
  viewerCount: number;
}

interface CachedOverlayStreamDetails {
  expectedStartedAt: string | null;
  expectedStreamId: string | null;
  checkedAt: number;
  details: OverlayStreamDetails | null;
}

interface OverlayStreamDetailsCache {
  details: OverlayStreamDetails | null;
  expiresAt: number;
}

interface CachedChannelGameId {
  checkedAt: number;
  gameId: string | null;
  /** True when `gameId` is null because the Helix lookup itself failed, not because the channel genuinely has no game set. */
  failed: boolean;
}

const revokedTokenKey = (tokenId: string): string => `overlay_revoked:${tokenId}`;

type SessionValidityRow = {
  session_id: string;
  user_id: string;
  role: ChannelRole | null;
};

type TokenValidityRow = { token_id: string; overlay_id: string | null };
type RevokedTokenMarker = { revokedAt: number };

type OverlayHandshakeWindow = { startedAt: number; count: number };
type RealtimeSocketAttachment = RealtimePrincipal;

type BufferedStatisticsWordCount = {
  streamId: string;
  word: string;
  count: number;
  lastSeenAt: string;
  lastIncrementAt: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const activeChatterKey = async (secretHex: string, channelId: string, userId: string): Promise<string> => {
  const encoder = new TextEncoder();
  const channel = encoder.encode(channelId);
  const user = encoder.encode(userId);
  const input = new Uint8Array(8 + channel.length + user.length);
  const view = new DataView(input.buffer);
  view.setUint32(0, channel.length);
  input.set(channel, 4);
  view.setUint32(4 + channel.length, user.length);
  input.set(user, 8 + channel.length);
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secretHex.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

type AlarmScheduleEntry = {
  /** The original scheduled time for this occurrence; stable across retries. */
  deadline: number;
  handler: string;
  /** The next execution time after a completed failed or retained attempt. */
  nextAttemptAt?: number;
  /** A durable lease left behind while the handler is running. */
  claimUntil?: number;
  failures?: number;
  revision?: number;
  ownerRevision?: number;
  streamGeneration?: number;
  identity?: ModuleAlarmIdentity;
  planSequence?: number;
  suppressedBy?: string;
};

type StoredClipJob = {
  version: 1;
  channelId: string;
  triggerId: string;
  actorUserId: string | null;
  settings: Pick<ClipsSettings, "postClipLinkInChat" | "chatLinkTemplate">;
  createdAt: string;
  attempts: number;
  nextAttemptAt: number;
  status: "pending" | "reporting_failure" | "complete" | "failed";
  clipId: string | null;
  createAttemptedAt?: number | null;
  editUrl: string | null;
  creationDetail: ClipCreationResult["detail"] | null;
  confirmedClip: CreateClipResult | null;
  failure: { channelId: string; triggerId: string; reason: string; attempts: number } | null;
  completedAt?: number;
};

const clipJobStorageKey = (triggerId: string): string => `${CLIP_JOB_STORAGE_PREFIX}${encodeURIComponent(triggerId)}`;

const isStoredClipJob = (value: unknown): value is StoredClipJob => {
  if (!isRecord(value)) return false;
  return value.version === 1 && typeof value.channelId === "string" && typeof value.triggerId === "string" &&
    (value.actorUserId === null || typeof value.actorUserId === "string") && isRecord(value.settings) &&
    typeof value.settings.postClipLinkInChat === "boolean" && typeof value.settings.chatLinkTemplate === "string" &&
    typeof value.createdAt === "string" && Number.isSafeInteger(value.attempts) && (value.attempts as number) >= 0 &&
    typeof value.nextAttemptAt === "number" && Number.isFinite(value.nextAttemptAt) &&
    (value.status === "pending" || value.status === "reporting_failure" || value.status === "complete" || value.status === "failed") &&
    (value.clipId === null || typeof value.clipId === "string") &&
    (value.createAttemptedAt === undefined || value.createAttemptedAt === null ||
      (typeof value.createAttemptedAt === "number" && Number.isFinite(value.createAttemptedAt))) &&
    (value.editUrl === null || typeof value.editUrl === "string") &&
    (value.creationDetail === null || isRecord(value.creationDetail)) &&
    (value.confirmedClip === null || isRecord(value.confirmedClip)) &&
    (value.failure === null || isRecord(value.failure));
};

type AlarmScheduleTable = Record<string, AlarmScheduleEntry>;
type ModuleAlarmPlanFenceRecord = {
  identity: ModuleAlarmIdentity | null;
  planSequence: number;
  cleared: boolean;
  updatedAt: number;
};
type AlarmHandlerResult = undefined | "retain";
type AlarmHandler = (key: string, entry: AlarmScheduleEntry, now: number, nowIso: string) => Promise<AlarmHandlerResult>;
type AlarmHandlerRegistration = {
  handle: AlarmHandler;
  retryDelaysMs?: readonly number[];
};

interface AlarmStorageAccess {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const validModuleAlarmIdentity = (value: unknown): value is ModuleAlarmIdentity =>
  isRecord(value) && typeof value.timerId === "string" && Number.isSafeInteger(value.revision) &&
  typeof value.triggerType === "string" && (typeof value.state === "string" || value.state === null) &&
  (typeof value.streamId === "string" || value.streamId === null) &&
  ((typeof value.generation === "number" && Number.isSafeInteger(value.generation)) || value.generation === null) &&
  typeof value.deadline === "number" && Number.isFinite(value.deadline);

const validAlarmScheduleEntry = (value: unknown): value is AlarmScheduleEntry =>
  isRecord(value) && typeof value.deadline === "number" && Number.isFinite(value.deadline) &&
  typeof value.handler === "string" && value.handler.length > 0 &&
  (value.nextAttemptAt === undefined || (typeof value.nextAttemptAt === "number" && Number.isFinite(value.nextAttemptAt))) &&
  (value.claimUntil === undefined || (typeof value.claimUntil === "number" && Number.isFinite(value.claimUntil))) &&
  (value.failures === undefined || (typeof value.failures === "number" && Number.isInteger(value.failures) && value.failures >= 0)) &&
  (value.revision === undefined || (typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0)) &&
  (value.ownerRevision === undefined || (typeof value.ownerRevision === "number" && Number.isInteger(value.ownerRevision) && value.ownerRevision >= 0)) &&
  (value.streamGeneration === undefined || (typeof value.streamGeneration === "number" && Number.isSafeInteger(value.streamGeneration) && value.streamGeneration >= 0)) &&
  (value.planSequence === undefined || (typeof value.planSequence === "number" && Number.isSafeInteger(value.planSequence) && value.planSequence >= 0)) &&
  (value.identity === undefined || validModuleAlarmIdentity(value.identity)) &&
  ((value.identity === undefined) === (value.planSequence === undefined)) &&
  (value.identity === undefined || value.identity.deadline === value.deadline) &&
  (value.suppressedBy === undefined || typeof value.suppressedBy === "string");

const validModuleAlarmPlanFence = (value: unknown): value is ModuleAlarmPlanFenceRecord =>
  isRecord(value) && Number.isSafeInteger(value.planSequence) && (value.planSequence as number) >= 0 &&
  (value.identity === null || validModuleAlarmIdentity(value.identity)) &&
  typeof value.cleared === "boolean" && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);

const alarmAttemptAt = (entry: AlarmScheduleEntry): number =>
  entry.claimUntil ?? entry.nextAttemptAt ?? entry.deadline;

const earliestAlarmAt = (table: AlarmScheduleTable, now: number): number | null => {
  const deadlines = Object.entries(table)
    .filter(([, entry]) => Number.isFinite(alarmAttemptAt(entry)))
    .filter(([, entry]) => !(entry.deadline <= now && entry.suppressedBy !== undefined &&
      Object.hasOwn(table, entry.suppressedBy)))
    .map(([, entry]) => alarmAttemptAt(entry));
  return deadlines.length === 0 ? null : Math.min(...deadlines);
};

const readAlarmScheduleTable = async (storage: AlarmStorageAccess): Promise<AlarmScheduleTable> => {
  const saved = await storage.get(ALARM_TABLE_KEY);
  const table: AlarmScheduleTable = {};
  if (isRecord(saved)) {
    for (const [key, value] of Object.entries(saved)) {
      if (validAlarmScheduleEntry(value)) table[key] = value;
    }
  }
  for (const definition of LEGACY_ALARM_DEFINITIONS) {
    const deadline = await storage.get(definition.key);
    const current = table[definition.key];
    if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
      // During a rollback the legacy implementation could clear its key while
      // the newer table still held the old deadline. The legacy key wins.
      Reflect.deleteProperty(table, definition.key);
      continue;
    }
    if (current !== undefined && alarmAttemptAt(current) === deadline) continue;

    // Legacy keys are the compatibility source of truth across a rollback.
    // A changed mirror is a new legacy deadline; discard retry/claim state
    // that the old implementation could not have understood.
    table[definition.key] = {
      deadline,
      handler: definition.handler,
      revision: (current?.revision ?? 0) + 1,
      ...( "suppressedBy" in definition ? { suppressedBy: definition.suppressedBy } : {}),
    };
  }
  return table;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isRealtimePrincipal = (value: unknown): value is RealtimePrincipal => {
  if (!isRecord(value) || value.v !== 1 || !isNonEmptyString(value.channelId)) return false;
  if (value.kind === "panel") {
    return isNonEmptyString(value.userId) &&
      isNonEmptyString(value.sessionId) &&
      typeof value.role === "string" && CHANNEL_ROLES.includes(value.role as ChannelRole) &&
      isNonEmptyString(value.expiresAt);
  }
  if (value.kind === "overlay") {
    return isNonEmptyString(value.tokenId) &&
      (value.overlayId === null || isNonEmptyString(value.overlayId)) &&
      (value.expiresAt === null || isNonEmptyString(value.expiresAt));
  }
  return false;
};

const isRealtimeSocketAttachment = (value: unknown): value is RealtimeSocketAttachment => {
  return isRealtimePrincipal(value);
};

const hasActiveRevocationMarker = (marker: unknown, now: number): boolean =>
  marker === true || (isRecord(marker) && typeof marker.revokedAt === "number" &&
    Number.isFinite(marker.revokedAt) && now - marker.revokedAt < OVERLAY_REVOKED_MARKER_TTL_MS);

const readAttachment = (webSocket: WebSocket): RealtimeSocketAttachment | null => {
  try {
    const attachment: unknown = webSocket.deserializeAttachment();
    return isRealtimeSocketAttachment(attachment) ? attachment : null;
  } catch {
    return null;
  }
};

const isExpired = (principal: RealtimePrincipal, now: number): boolean => {
  if (principal.expiresAt === null) return false;
  const expiresAt = Date.parse(principal.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
};

const closeSocket = (webSocket: WebSocket, code: number, reason: string): boolean => {
  try {
    webSocket.close(code, reason);
    return true;
  } catch {
    // The socket may already have closed between selection and close.
    return false;
  }
};

const tagsFor = (principal: RealtimePrincipal): string[] => principal.kind === "panel"
  ? [`kind:${principal.kind}`, `user:${principal.userId}`, `session:${principal.sessionId}`]
  : [`kind:${principal.kind}`, `token:${principal.tokenId}`,
    ...(principal.overlayId === null ? [] : [`overlay:${principal.overlayId}`])];

const chunksOf = <T>(values: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
};

const envelopeFor = (
  channelId: string,
  type: "system.hello",
): RealtimeEnvelope<"system.hello"> => ({
  version: 1,
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  channelId,
  type,
  payload: {},
});

/**
 * Channel-bound realtime room. Hibernation is a hard invariant here: no
 * class field holds authoritative state that must survive eviction. Word-count
 * buffering is intentionally approximate and is flushed by the statistics alarm.
 * Principals and tags live on the socket; the only periodic work is in the
 * alarm, and the authorization data lives in D1.
 */
export class ChannelObject extends DurableObject<Env> {
  private overlayStreamDetailsRefreshes = new Map<string, Promise<OverlayStreamDetailsCache>>();
  private channelGameIdRefresh: Promise<CachedChannelGameId> | null = null;
  private adScheduleRefresh: Promise<AdScheduleRefreshResult> | null = null;
  private adScheduleRefreshStartedAt = 0;
  private adScheduleRefreshGeneration = 0;
  private adScheduleOperationQueue: Promise<void> = Promise.resolve();
  private belaboxPollQueue: Promise<void> = Promise.resolve();
  private moduleLifecycleMutationQueue: Promise<void> = Promise.resolve();
  private statisticsWindowAlarmQueue: Promise<void> = Promise.resolve();
  private statisticsWordCounts = new Map<string, BufferedStatisticsWordCount>();
  private statisticsWordWordsByStream = new Map<string, Set<string>>();
  private statisticsWordNewDistinctByStream = new Map<string, number>();
  private statisticsWordStreamEndedAt = new Map<string, number>();
  /** Latest increment per stream that is still buffered in memory, so idle checks see unflushed activity. */
  private statisticsWordLastBufferedIncrementAt = new Map<string, number>();
  private alarmScheduleQueue: Promise<void> = Promise.resolve();
  private timerScheduleReconciliationQueue: Promise<void> = Promise.resolve();
  private timerScheduleInputGeneration = 0;
  private timerScheduleInitialization: Promise<void> | null = null;
  private timerOccurrenceQueues = new Map<string, Promise<void>>();
  private activeChatterSchemaReady = false;
  private statisticsSchemaReady = false;
  private eventSubMessageIdSchemaReady = false;
  private pointsSchemaReady = false;
  private pointsInitialized = false;
  private pointsInitialization: Promise<void> | null = null;
  private pointRoundRecoveryInitialized = false;
  private pointRoundRecoveryInitialization: Promise<void> | null = null;
  // ponytail: This Set is per-instance memory and is empty after hibernation, so the residual window is bounded by the security alarm. Persist token IDs in DO storage if that window needs to be shorter.
  private recentlyBoundOverlayTokenIds = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Atomically reserves one quick-action test message per channel every 30 seconds. */
  public async claimTestMessageSend(now: number): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
    return claimTestMessageSendInStorage(this.ctx.storage, now);
  }

  /** Releases an unused quick-action reservation without clearing a newer claim. */
  public async releaseTestMessageSend(claimedAt: number): Promise<boolean> {
    return releaseTestMessageSendInStorage(this.ctx.storage, claimedAt);
  }

  private ensurePointsSchema(): void {
    if (this.pointsSchemaReady) return;
    ensurePointsSchema(this.ctx.storage.sql);
    this.pointsSchemaReady = true;
  }

  private async ensurePointsInitialized(): Promise<void> {
    const pendingInitialization = this.pointsInitialization;
    if (pendingInitialization !== null) {
      await pendingInitialization;
      return;
    }
    if (this.pointsInitialized) return;
    const initialization = this.initializePoints();
    this.pointsInitialization = initialization;
    try {
      await initialization;
      this.pointsInitialized = true;
    } finally {
      if (this.pointsInitialization === initialization) this.pointsInitialization = null;
    }
  }

  /** Restores local point alarms on the first non-snapshot entry after activation. */
  private async ensurePointRoundRecovery(): Promise<void> {
    const pendingInitialization = this.pointRoundRecoveryInitialization;
    if (pendingInitialization !== null) {
      await pendingInitialization;
      return;
    }
    if (this.pointRoundRecoveryInitialized) return;
    const initializedSchema = this.ctx.storage.sql.exec<{ present: number }>(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'game_rounds') AS present",
    ).one().present === 1;
    if (!initializedSchema) {
      this.pointRoundRecoveryInitialized = true;
      return;
    }

    this.ensurePointsSchema();
    const hasActiveRounds = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM game_rounds WHERE state IN ('announcing', 'open', 'resolving')
        OR prepare_state = 'pending' OR (state = 'resolved' AND resolve_delivery_state IN ('pending', 'sending'))`,
    ).one().count > 0;
    const hasPendingCancellations = pendingPointRoundCancellations(this.ctx.storage.sql).length > 0;
    const hasPendingNotices = pendingPointRoundCancellationNotices(this.ctx.storage.sql).length > 0;
    const hasActivationReconciliation = this.pointActivationReconciliationModulesSync().length > 0;
    if (!hasActiveRounds && !hasPendingCancellations && !hasPendingNotices && !hasActivationReconciliation) {
      this.pointRoundRecoveryInitialized = true;
      return;
    }

    const initialization = this.recoverPointRoundAlarms();
    this.pointRoundRecoveryInitialization = initialization;
    try {
      await initialization;
      this.pointRoundRecoveryInitialized = true;
    } finally {
      if (this.pointRoundRecoveryInitialization === initialization) this.pointRoundRecoveryInitialization = null;
    }
  }

  private async initializePoints(): Promise<void> {
    this.ensurePointsSchema();
    await this.ensurePointRoundRecovery();
  }

  private ownChannelId(): string | null {
    const name = this.ctx.id.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  }

  private async serializeBelaboxPoll<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.belaboxPollQueue;
    let release!: () => void;
    this.belaboxPollQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async runModuleAlarmHandler<Result>(
    moduleId: string,
    handlerKey: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (moduleId === "belabox" && handlerKey === "poll") return await this.serializeBelaboxPoll(operation);
    if (moduleId === "statistics") return await this.serializeStatisticsWindowAlarm(operation);
    if (MODULES.find((module) => module.id === moduleId)?.serializeLifecycleMutations === true) {
      return await this.serializeModuleLifecycleMutation(operation);
    }
    return await operation();
  }

  private async serializeStatisticsWindowAlarm<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.statisticsWindowAlarmQueue;
    let release!: () => void;
    this.statisticsWindowAlarmQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async serializeModuleLifecycleMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.moduleLifecycleMutationQueue;
    let release!: () => void;
    this.moduleLifecycleMutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private ensureActiveChatterTable(): void {
    if (this.activeChatterSchemaReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ACTIVE_CHATTER_TABLE} (
        hmac TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )`,
    );
    // EXPLAIN QUERY PLAN reports a covering-index range search for last_seen_at >= ?.
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS active_chatters_last_seen_at_idx
       ON ${ACTIVE_CHATTER_TABLE} (last_seen_at)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ACTIVE_CHATTER_KEY_TABLE} (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        key_hex TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
    this.activeChatterSchemaReady = true;
  }

  private ensureStatisticsSchema(): void {
    if (this.statisticsSchemaReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATISTICS_CHAT_WINDOW_TABLE} (
        window_start INTEGER PRIMARY KEY,
        stream_id TEXT,
        messages INTEGER NOT NULL DEFAULT 0,
        emotes INTEGER NOT NULL DEFAULT 0,
        viewer_count INTEGER,
        chatters INTEGER,
        active_chatters INTEGER,
        metrics_sampled INTEGER NOT NULL DEFAULT 0,
        active_chatters_sampled INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 1,
        complete INTEGER NOT NULL DEFAULT 0
      )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS statistics_chat_windows_flush_idx
       ON ${STATISTICS_CHAT_WINDOW_TABLE} (dirty, complete, window_start)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATISTICS_WORD_STREAM_TABLE} (
        stream_id TEXT PRIMARY KEY,
        distinct_words INTEGER NOT NULL DEFAULT 0,
        ended_at INTEGER,
        expires_at INTEGER NOT NULL,
        current_batch INTEGER NOT NULL DEFAULT 1
      )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS statistics_word_streams_expiry_idx
       ON ${STATISTICS_WORD_STREAM_TABLE} (expires_at)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATISTICS_CLIP_IMPORT_TABLE} (
        stream_id TEXT PRIMARY KEY,
        started_at TEXT,
        ended_at INTEGER NOT NULL,
        ready_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS statistics_clip_imports_ready_idx
       ON ${STATISTICS_CLIP_IMPORT_TABLE} (ready_at, expires_at)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATISTICS_WORD_COUNT_TABLE} (
        stream_id TEXT NOT NULL,
        batch INTEGER NOT NULL,
        word TEXT NOT NULL,
        count INTEGER NOT NULL CHECK (count > 0),
        last_seen_at TEXT NOT NULL,
        last_increment_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, batch, word)
      ) WITHOUT ROWID`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${STATISTICS_WORD_SEEN_TABLE} (
        stream_id TEXT NOT NULL,
        word TEXT NOT NULL,
        PRIMARY KEY (stream_id, word)
      ) WITHOUT ROWID`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS statistics_word_counts_top_idx
       ON ${STATISTICS_WORD_COUNT_TABLE} (stream_id, batch, count DESC, word ASC)`,
    );
    this.statisticsSchemaReady = true;
  }

  private ensureEventSubMessageIdTable(): void {
    if (this.eventSubMessageIdSchemaReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${EVENTSUB_MESSAGE_ID_TABLE} (
        message_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS eventsub_message_ids_received_idx
       ON ${EVENTSUB_MESSAGE_ID_TABLE} (received_at)`,
    );
    this.eventSubMessageIdSchemaReady = true;
  }

  private reconcileLegacyActiveChatterStream(): void {
    if (this.ctx.storage.kv.get(LEGACY_ACTIVE_CHATTER_STREAM_KEY) === undefined) return;
    this.ensureActiveChatterTable();
    this.ctx.storage.transactionSync(() => {
      if (this.activeChatterKeyRowSync() === null) this.clearActiveChatterStateSync();
      else this.ctx.storage.kv.delete(LEGACY_ACTIVE_CHATTER_STREAM_KEY);
    });
  }

  private incrementChatActivityCountSync(): number {
    const schedule = this.timerScheduleStateSync();
    const next = this.currentChatActivityCountSync() + 1;
    this.ctx.storage.kv.put(CHAT_ACTIVITY_COUNT_KEY, next);
    if (schedule.stream.state === "online") schedule.activityCounts.live += 1;
    else if (schedule.stream.state === "offline") schedule.activityCounts.offline += 1;
    this.ctx.storage.kv.put(TIMER_ACTIVITY_COUNTS_KEY, schedule.activityCounts);
    return next;
  }

  private currentChatActivityCountSync(): number {
    const current = this.ctx.storage.kv.get<number>(CHAT_ACTIVITY_COUNT_KEY);
    return typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current : 0;
  }

  private timerScheduleStateSync(): DurableTimerState {
    const saved = this.ctx.storage.kv.get<DurableTimerState>(TIMER_DURABLE_STATE_KEY);
    const state = saved ?? emptyDurableTimerState();
    state.activityCounts = this.timerActivityCountsSync(saved?.initialized === true ? saved.activityCounts : undefined);
    state.pendingSkipAudits ??= {};
    return state;
  }

  private timerActivityCountsSync(legacyCounts?: Record<TimerIntervalState, number>): Record<TimerIntervalState, number> {
    const saved = this.ctx.storage.kv.get<Record<TimerIntervalState, number>>(TIMER_ACTIVITY_COUNTS_KEY);
    if (saved !== undefined && Number.isSafeInteger(saved.live) && saved.live >= 0 &&
        Number.isSafeInteger(saved.offline) && saved.offline >= 0) return saved;
    const count = Math.max(this.currentChatActivityCountSync(),
      Number.isSafeInteger(legacyCounts?.live) && (legacyCounts?.live ?? 0) >= 0 ? legacyCounts?.live ?? 0 : 0,
      Number.isSafeInteger(legacyCounts?.offline) && (legacyCounts?.offline ?? 0) >= 0 ? legacyCounts?.offline ?? 0 : 0);
    const baseline = { live: count, offline: count };
    this.ctx.storage.kv.put(TIMER_ACTIVITY_COUNTS_KEY, baseline);
    return baseline;
  }

  private writeTimerDurableStateSync(state: DurableTimerState): void {
    const persisted = { ...state } as Partial<DurableTimerState>;
    Reflect.deleteProperty(persisted, "activityCounts");
    this.ctx.storage.kv.put(TIMER_ACTIVITY_COUNTS_KEY, state.activityCounts);
    this.ctx.storage.kv.put(TIMER_DURABLE_STATE_KEY, persisted);
  }

  private pruneTimerTombstonesSync(state: DurableTimerState): void {
    const cutoff = Date.now() - TIMER_TOMBSTONE_RETENTION_MS;
    for (const [timerId, tombstone] of Object.entries(state.tombstones)) {
      if (!Number.isFinite(tombstone.deletedAt) || tombstone.deletedAt < cutoff) {
        Reflect.deleteProperty(state.tombstones, timerId);
      }
    }
  }

  private timerTombstoneRevision(state: DurableTimerState, timerId: string): number {
    return state.tombstones[timerId]?.revision ?? -1;
  }

  private timerAlarmScheduleSync(): AlarmScheduleTable {
    const saved = this.ctx.storage.kv.get(ALARM_TABLE_KEY);
    const table: AlarmScheduleTable = {};
    if (isRecord(saved)) {
      for (const [key, value] of Object.entries(saved)) {
        if (validAlarmScheduleEntry(value)) table[key] = value;
      }
    }
    return table;
  }

  private timerAlarmEntryKey(timerId: string): string {
    return `${TIMER_ALARM_PREFIX}${timerAlarmKeyFor(timerId)}`;
  }

  private writeTimerAlarmEntriesSync(timerId: string, entry: DurableTimerEntry | undefined): void {
    const table = this.timerAlarmScheduleSync();
    const occurrenceKey = this.timerAlarmEntryKey(timerId);
    const previous = table[occurrenceKey];
    if (entry?.plannedOccurrence !== null && entry?.plannedOccurrence !== undefined) {
      const { identity, sequence } = entry.plannedOccurrence;
      table[occurrenceKey] = {
        deadline: identity.deadline,
        handler: TIMER_OCCURRENCE_HANDLER,
        revision: (previous?.revision ?? 0) + 1,
        ownerRevision: entry.config.revision,
        ...(identity.generation === null ? {} : { streamGeneration: identity.generation }),
        identity,
        planSequence: sequence,
      };
    } else {
      Reflect.deleteProperty(table, occurrenceKey);
    }
    const refreshPrefix = `${occurrenceKey}:refresh:`;
    for (const key of Object.keys(table)) {
      if (key.startsWith(refreshPrefix)) Reflect.deleteProperty(table, key);
    }
    if (entry?.refreshAt !== null && entry?.refreshAt !== undefined) {
      const refreshKey = eventTimeRefreshKeyFor(timerId, entry.refreshAt);
      const alarmKey = `${TIMER_ALARM_PREFIX}${refreshKey}`;
      table[alarmKey] = {
        deadline: entry.refreshAt,
        handler: TIMER_OCCURRENCE_HANDLER,
        revision: (table[alarmKey]?.revision ?? 0) + 1,
        ownerRevision: entry.config.revision,
      };
    }
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private writeTimerMirrorRetryAlarmSync(timerId: string, sequence: number, deadline: number | null): void {
    const table = this.timerAlarmScheduleSync();
    const key = `${TIMER_ALARM_PREFIX}mirror:${timerId}:${String(sequence)}`;
    if (deadline === null) Reflect.deleteProperty(table, key);
    else table[key] = {
      deadline,
      handler: TIMER_OCCURRENCE_HANDLER,
      revision: (table[key]?.revision ?? 0) + 1,
    };
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private persistTimerScheduleSync(state: DurableTimerState, timerId: string, entry?: DurableTimerEntry): void {
    if (entry === undefined) Reflect.deleteProperty(state.timers, timerId);
    else state.timers[timerId] = entry;
    this.writeTimerDurableStateSync(state);
    this.writeTimerAlarmEntriesSync(timerId, entry);
  }

  private setTimerPlanSync(
    entry: DurableTimerEntry,
    plan: TimerPlan,
    stream: DurableTimerStream,
    inputs: TimerScheduleInputs,
  ): void {
    const skippedOccurrence = entry.skippedOccurrence;
    const previousPlannedOccurrence = entry.plannedOccurrence;
    const inFlightClaim = entry.inFlightClaim;
    const skipAuditOperationId = entry.skipAuditOperationId ?? null;
    const skipReceipts = timerSkipReceiptsForSchedule(entry, inputs.now, stream);
    if (skippedOccurrence !== null && skippedOccurrence !== undefined &&
        sameTimerScheduledOccurrence(skippedOccurrence, entry.plannedOccurrence) &&
        (skippedOccurrence.identity.triggerType !== "stream_start" || stream.state === "unknown" ||
          stream.state === "online" && stream.streamId === skippedOccurrence.identity.streamId &&
          stream.generation === skippedOccurrence.identity.generation)) {
      const occurrenceKey = timerSkipReceiptKey(skippedOccurrence);
      const receipt = skipReceipts.find((candidate) => candidate.occurrenceKey === occurrenceKey);
      if (receipt === undefined) {
        skipReceipts.push({
          occurrenceKey,
          deadline: skippedOccurrence.identity.deadline,
          auditOperationId: skipAuditOperationId,
        });
      } else if (receipt.auditOperationId === null && skipAuditOperationId !== null) {
        receipt.auditOperationId = skipAuditOperationId;
      }
    }
    entry.skipReceipts = skipReceipts;
    entry.planSequence += 1;
    entry.plannedOccurrence = plan.identity === null
      ? null
      : { identity: plan.identity, sequence: entry.planSequence } satisfies TimerOccurrence;
    if (!sameTimerScheduledOccurrence(inFlightClaim?.occurrence, previousPlannedOccurrence) ||
        !sameTimerScheduledOccurrence(inFlightClaim?.occurrence, entry.plannedOccurrence)) {
      entry.inFlightClaim = null;
    }
    entry.skipReceipts = timerSkipReceiptsForSchedule(entry, inputs.now, stream);
    const plannedOccurrence = entry.plannedOccurrence;
    const matchingSkipReceipt = plannedOccurrence === null
      ? undefined
      : entry.skipReceipts.find(({ occurrenceKey }) => occurrenceKey === timerSkipReceiptKey(plannedOccurrence));
    const keepsSkippedOccurrence = matchingSkipReceipt !== undefined;
    entry.skippedOccurrence = keepsSkippedOccurrence ? plannedOccurrence : null;
    if (matchingSkipReceipt !== undefined && plannedOccurrence !== null) {
      const effectivePlan = makeTimerPlan(entry.config, stream, plannedOccurrence, {
        ...inputs,
        now: Math.max(inputs.now, plannedOccurrence.identity.deadline),
      }, "after_occurrence", entry.completedStreamId);
      entry.effectiveNextOccurrence = effectivePlan.identity === null
        ? null
        : { identity: effectivePlan.identity, sequence: entry.planSequence + 1 } satisfies TimerOccurrence;
    } else {
      entry.effectiveNextOccurrence = null;
    }
    entry.skipAuditOperationId = matchingSkipReceipt?.auditOperationId ?? null;
    entry.refreshAt = plan.refreshAt;
    entry.mirrorSequence += 1;
  }

  private newDurableTimerEntry(config: DurableTimerConfig, state: DurableTimerState): DurableTimerEntry {
    return {
      config,
      plannedOccurrence: null,
      skippedOccurrence: null,
      skipReceipts: [],
      inFlightClaim: null,
      planSequence: 0,
      mirrorSequence: 0,
      activityBaselines: { live: state.activityCounts.live, offline: state.activityCounts.offline },
      lastRunAt: null,
      refreshAt: null,
    };
  }

  private previousTimerOccurrenceFromAlarm(
    config: DurableTimerConfig,
    stream: DurableTimerStream,
    inputs: TimerScheduleInputs,
    legacyStreamId: string | null | undefined,
  ): TimerOccurrence | null {
    const alarm = this.timerAlarmScheduleSync()[this.timerAlarmEntryKey(config.id)];
    const trigger = config.trigger;
    const identity = alarm?.identity;
    const sequence = alarm?.planSequence;
    if (identity !== undefined && sequence !== undefined) {
      if (identity.timerId !== config.id || identity.revision !== config.revision ||
          identity.triggerType !== config.trigger.type) return null;
      const occurrence = { identity, sequence };
      switch (trigger.type) {
        case "interval":
        case "stream_start":
          return this.timerStreamMatchesOccurrence(stream, occurrence) ? occurrence : null;
        case "time_of_day":
          return isDailyTimerDeadlineCurrent(trigger, identity.deadline, inputs.timeZone) ? occurrence : null;
        case "before_event":
          return inputs.eventTimes.some((event) => event.id === trigger.sourceId &&
            Date.parse(event.at) - trigger.minutes * 60_000 === identity.deadline)
            ? occurrence
            : null;
      }
    }

    // Prior releases stored only deadline and owner revision in the channel alarm table.
    // Upgrade that same durable alarm into a full occurrence identity once, without
    // consulting D1's display mirror.
    if (alarm === undefined || alarm.handler !== TIMER_OCCURRENCE_HANDLER ||
        alarm.ownerRevision !== config.revision || !Number.isFinite(alarm.deadline)) return null;
    const deadline = alarm.deadline;
    let state: string | null = null;
    let streamId: string | null = null;
    let generation: number | null = null;
    switch (trigger.type) {
      case "interval": {
        const intervalState = stream.state === "online" ? "live" : stream.state === "offline" ? "offline" : null;
        if (intervalState === null || intervalPartFor(trigger, intervalState) === undefined) return null;
        if (intervalState === "live" ? legacyStreamId !== stream.streamId : legacyStreamId !== null) return null;
        state = intervalState;
        streamId = intervalState === "live" ? stream.streamId : null;
        generation = stream.generation;
        break;
      }
      case "stream_start": {
        if (stream.state !== "online" || stream.streamId === null || stream.startedAt === null ||
            !sameStreamStartedAt(new Date(deadline - triggerDelayMs(trigger)).toISOString(), stream.startedAt)) return null;
        streamId = stream.streamId;
        generation = stream.generation;
        break;
      }
      case "time_of_day":
        if (!isDailyTimerDeadlineCurrent(trigger, deadline, inputs.timeZone)) return null;
        break;
      case "before_event":
        if (!inputs.eventTimes.some((event) => event.id === trigger.sourceId &&
            Date.parse(event.at) - trigger.minutes * 60_000 === deadline)) return null;
        break;
    }
    if (streamId !== null) this.importLegacyTimerSendClaim(config.id, deadline, streamId, trigger.type);
    return {
      identity: {
        timerId: config.id,
        revision: config.revision,
        triggerType: trigger.type,
        state,
        streamId,
        generation,
        deadline,
      },
      sequence: sequence ?? 0,
    };
  }

  /**
   * Copies a persisted legacy send claim (deadline-based key, with or without stream suffix) to
   * the key the current code uses. stream_start posts are keyed by (timer, stream) alone.
   * Returns the claim status that now guards the occurrence, or null when none exists.
   */
  private importLegacyTimerSendClaim(
    timerId: string,
    deadline: number,
    streamId: string,
    triggerType?: string,
  ): "sending" | "sent" | null {
    // One-time rollout step: once the first bootstrap finished, legacy keys are never consulted again.
    if (this.ctx.storage.kv.get(LEGACY_TIMER_CLAIMS_IMPORTED_KEY) === true) return null;
    const targetKey = triggerType === "stream_start"
      ? streamStartIdempotencyKey(timerId, streamId)
      : timerOccurrenceKey(timerId, deadline, streamId);
    const saved = this.ctx.storage.kv.get(MODULE_ALARM_SEND_CLAIMS_KEY);
    if (!isRecord(saved)) return null;
    const existing = saved[targetKey];
    if (isRecord(existing) && (existing.status === "sending" || existing.status === "sent")) return existing.status;
    const sourceKeys = [timerOccurrenceKey(timerId, deadline), timerOccurrenceKey(timerId, deadline, streamId)];
    if (triggerType === "stream_start") {
      // Helix may report the same stream's start with different sub-second digits than the
      // legacy worker saw, so accept a deadline within one second; the stream suffix alone
      // never qualifies (it would also match interval claims of the same stream).
      const prefix = `${timerId}:`;
      const suffix = encodeURIComponent(streamId);
      for (const key of Object.keys(saved)) {
        const match = key.startsWith(prefix) ? /^(\d+)(?::(.*))?$/.exec(key.slice(prefix.length)) : null;
        if (match === null || sourceKeys.includes(key)) continue;
        if (Math.abs(Number(match[1]) - deadline) < 1000 && (match[2] === undefined || match[2] === suffix)) sourceKeys.push(key);
      }
    }
    for (const sourceKey of sourceKeys) {
      if (sourceKey === targetKey) continue;
      const claim = saved[sourceKey];
      if (!isRecord(claim) || (claim.status !== "sending" && claim.status !== "sent") ||
          typeof claim.at !== "number") continue;
      this.ctx.storage.kv.put(MODULE_ALARM_SEND_CLAIMS_KEY, { ...saved, [targetKey]: claim });
      return claim.status;
    }
    return null;
  }

  private async readTimerConfigsFromDatabase(): Promise<DurableTimerConfig[]> {
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Timer schedules require a named Durable Object.");
    const rows = await this.env.DB.prepare(
      `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target,
              use_channel_default_target, revision, created_at, updated_at
         FROM timers WHERE channel_id = ? ORDER BY created_at, timer_id`,
    ).bind(channelId).all<Omit<TimerRow, "next_run_at" | "next_run_state" | "last_run_at">>();
    return rows.results.map((row) => {
      const timer = mapTimerRow({ ...row, next_run_at: null, next_run_state: null, last_run_at: null });
      return {
        id: timer.id,
        name: timer.name,
        enabled: timer.enabled,
        messageText: timer.messageText,
        chatTarget: timer.chatTarget,
        trigger: timer.trigger,
        revision: timer.revision,
      };
    });
  }

  private async readLegacyTimerActivityBaselines(): Promise<Map<string, {
    count: number | null;
    streamId: string | null;
    nextRunStreamId: string | null;
  }>> {
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Timer schedules require a named Durable Object.");
    const rows = await this.env.DB.prepare(
      `SELECT timer_id, last_chat_activity_count, chat_baseline_stream_id, next_run_stream_id
         FROM timers WHERE channel_id = ? AND trigger_type = 'interval'`,
    ).bind(channelId).all<{
      timer_id: string;
      last_chat_activity_count: number | null;
      chat_baseline_stream_id: string | null;
      next_run_stream_id: string | null;
    }>();
    return new Map(rows.results.map((row) => [row.timer_id, {
      count: Number.isSafeInteger(row.last_chat_activity_count) && (row.last_chat_activity_count ?? -1) >= 0
        ? row.last_chat_activity_count ?? 0
        : null,
      streamId: row.chat_baseline_stream_id,
      nextRunStreamId: row.next_run_stream_id,
    }]));
  }

  private async readTimerConfigFromDatabase(timerId: string): Promise<DurableTimerConfig | null> {
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Timer schedules require a named Durable Object.");
    const row = await this.env.DB.prepare(
      `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target,
              use_channel_default_target, revision, created_at, updated_at
         FROM timers WHERE channel_id = ? AND timer_id = ?`,
    ).bind(channelId, timerId).first<Omit<TimerRow, "next_run_at" | "next_run_state" | "last_run_at">>();
    if (row === null) return null;
    const timer = mapTimerRow({ ...row, next_run_at: null, next_run_state: null, last_run_at: null });
    return {
      id: timer.id,
      name: timer.name,
      enabled: timer.enabled,
      messageText: timer.messageText,
      chatTarget: timer.chatTarget,
      trigger: timer.trigger,
      revision: timer.revision,
    };
  }

  private async refreshTimerOccurrenceSnapshot(timerId: string): Promise<void> {
    const [config, stream] = await Promise.all([
      this.readTimerConfigFromDatabase(timerId),
      this.readTimerStreamFromDatabase(),
    ]);
    await this.transitionTimerStream(stream);
    if (config === null) {
      const current = this.timerScheduleStateSync().timers[timerId];
      if (current !== undefined) await this.deleteTimerConfig(timerId, current.config.revision);
      return;
    }
    await this.upsertTimerConfig(config);
  }

  private async readTimerStreamFromDatabase(): Promise<DurableTimerStream> {
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Timer schedules require a named Durable Object.");
    const row = await this.env.DB.prepare(
      `SELECT state, stream_id, started_at, transition_generation
         FROM channel_stream_state WHERE channel_id = ?`,
    ).bind(channelId).first<{
      state: "online" | "offline" | "unknown";
      stream_id: string | null;
      started_at: string | null;
      transition_generation: number;
    }>();
    return {
      state: row?.state ?? "unknown",
      streamId: row?.stream_id ?? null,
      startedAt: row?.started_at ?? null,
      generation: row?.transition_generation ?? 0,
    };
  }

  private async timerScheduleInputs(
    configs: readonly DurableTimerConfig[],
    now: number,
  ): Promise<TimerScheduleInputs> {
    const needsCalendar = configs.some(({ trigger }) => trigger.type === "time_of_day" || trigger.type === "before_event");
    const needsEventTimes = configs.some(({ trigger }) => trigger.type === "before_event");
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Timer schedules require a named Durable Object.");
    const [channel, eventTimes] = await Promise.all([
      needsCalendar
        ? this.env.DB.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
          .bind(channelId).first<{ time_zone: string }>()
        : Promise.resolve(null),
      needsEventTimes ? resolveModuleEventTimes(this.env.DB, channelId, now) : Promise.resolve([]),
    ]);
    return { now, timeZone: channel?.time_zone ?? "Europe/Berlin", eventTimes };
  }

  private async ensureTimerSchedulesInitialized(): Promise<void> {
    const pendingInitialization = this.timerScheduleInitialization;
    if (pendingInitialization !== null) {
      await pendingInitialization;
      return;
    }
    if (this.timerScheduleStateSync().initialized) return;
    const initialization = this.initializeTimerSchedules();
    this.timerScheduleInitialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.timerScheduleInitialization === initialization) this.timerScheduleInitialization = null;
    }
  }

  private async initializeTimerSchedules(): Promise<void> {
    const [configs, stream, legacyActivityBaselines] = await Promise.all([
      this.readTimerConfigsFromDatabase(),
      this.readTimerStreamFromDatabase(),
      this.readLegacyTimerActivityBaselines(),
    ]);
    const inputs = await this.timerScheduleInputs(configs, Date.now());
    const changedTimerIds: string[] = [];
    this.ctx.storage.transactionSync(() => {
        const state = this.timerScheduleStateSync();
        if (state.initialized) return;
        if (stream.generation >= state.stream.generation) state.stream = stream;
        state.initialized = true;
        for (const config of configs) {
          if (this.timerTombstoneRevision(state, config.id) >= config.revision) continue;
          const existing = state.timers[config.id];
          if (existing !== undefined && existing.config.revision >= config.revision) continue;
          const entry = existing ?? this.newDurableTimerEntry(config, state);
          entry.config = config;
          entry.activityBaselines = { ...state.activityCounts };
          const legacyBaseline = legacyActivityBaselines.get(config.id);
          if (config.trigger.type === "interval" && state.stream.state === "online" &&
              legacyBaseline?.streamId === state.stream.streamId && legacyBaseline.count !== null) {
            entry.activityBaselines.live = Math.min(state.activityCounts.live, legacyBaseline.count);
          }
          if (config.trigger.type === "stream_start" && state.stream.state === "online" &&
              state.stream.streamId !== null && state.stream.startedAt !== null &&
              this.importLegacyTimerSendClaim(config.id,
                Date.parse(state.stream.startedAt) + triggerDelayMs(config.trigger),
                state.stream.streamId, "stream_start") === "sent") {
            entry.completedStreamId = state.stream.streamId;
          }
          const existingOccurrence = existing?.plannedOccurrence;
          const persistedOccurrence = existingOccurrence?.identity.revision === config.revision
            ? existingOccurrence
            : this.previousTimerOccurrenceFromAlarm(config, state.stream, inputs, legacyBaseline?.nextRunStreamId);
          if (persistedOccurrence === null) {
            this.setTimerPlanSync(entry, makeTimerPlan(config, state.stream, null, inputs, "reset", entry.completedStreamId),
              state.stream, inputs);
          } else {
            entry.plannedOccurrence = persistedOccurrence;
            entry.planSequence = persistedOccurrence.sequence;
            if (!sameTimerScheduledOccurrence(entry.inFlightClaim?.occurrence, persistedOccurrence)) {
              entry.inFlightClaim = null;
            }
            entry.refreshAt = null;
            entry.mirrorSequence += 1;
          }
          state.timers[config.id] = entry;
          this.writeTimerAlarmEntriesSync(config.id, entry);
          changedTimerIds.push(config.id);
        }
        this.writeTimerDurableStateSync(state);
        this.ctx.storage.kv.put(LEGACY_TIMER_CLAIMS_IMPORTED_KEY, true);
    });
    await Promise.all(changedTimerIds.map((timerId) => this.writeTimerMirror(timerId)));
    if (changedTimerIds.some((timerId) => {
      const entry = this.timerScheduleStateSync().timers[timerId];
      return entry !== undefined && sameTimerScheduledOccurrence(entry.skippedOccurrence, entry.plannedOccurrence);
    })) await this.notifyCommittedPanelResources();
    await this.scheduleEarliestAlarm();
  }

  /** Applies a committed timer config revision in the channel's single scheduler. */
  public async upsertTimerConfig(config: DurableTimerConfig): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ensureTimerSchedulesInitialized();
    await this.transitionTimerStream(await this.readTimerStreamFromDatabase());
    const inputs = await this.timerScheduleInputs([config], Date.now());
    const changed = this.ctx.storage.transactionSync(() => {
      const state = this.timerScheduleStateSync();
      if (this.timerTombstoneRevision(state, config.id) >= config.revision) return false;
      const current = state.timers[config.id];
      if (current !== undefined && current.config.revision >= config.revision) return false;
      const entry = current ?? this.newDurableTimerEntry(config, state);
      const previousTriggerType = current?.config.trigger.type;
      const triggerChanged = current === undefined || JSON.stringify(current.config.trigger) !== JSON.stringify(config.trigger);
      entry.config = config;
      if (triggerChanged && (previousTriggerType === "interval" || config.trigger.type === "interval")) {
        entry.activityBaselines = { ...state.activityCounts };
      }
      const skippedOccurrenceIsPlanned = sameTimerScheduledOccurrence(current?.skippedOccurrence, current?.plannedOccurrence);
      const preserveSkippedOccurrence = skippedOccurrenceIsPlanned && previousTriggerType === config.trigger.type;
      this.setTimerPlanSync(entry,
        makeTimerPlan(config, state.stream, current?.plannedOccurrence ?? null, inputs,
          triggerChanged && !preserveSkippedOccurrence ? "reset" : "preserve_cadence", entry.completedStreamId),
      state.stream, inputs);
      this.persistTimerScheduleSync(state, config.id, entry);
      return true;
    });
    if (changed) {
      await this.writeTimerMirror(config.id);
      const entry = this.timerScheduleStateSync().timers[config.id];
      if (entry !== undefined && sameTimerScheduledOccurrence(entry.skippedOccurrence, entry.plannedOccurrence)) {
        await this.notifyCommittedPanelResources();
      }
    }
    await this.scheduleEarliestAlarm();
  }

  /** Serializes an operator skip against the full alarm send path for this timer. */
  public async skipNextTimerOccurrence(
    timerId: string,
    expectedRevision: number,
    actor: ActorContext,
  ): Promise<SkipTimerOccurrenceResult> {
    const outcome = await this.withTimerOccurrenceOperation<TimerSkipOperationOutcome>(timerId, async () => {
      await this.ensurePointRoundRecovery();
      await this.ensureTimerSchedulesInitialized();
      const channelId = this.ownChannelId();
      if (channelId === null) return { result: { result: "denied" }, mirrorChanged: false, auditOperationId: null };

      for (let attempt = 0; attempt < MAX_TIMER_SKIP_PREPARATION_ATTEMPTS; attempt += 1) {
        await this.refreshTimerOccurrenceSnapshot(timerId);
        const current = this.timerScheduleStateSync().timers[timerId];
        const inputGeneration = this.timerScheduleInputGeneration;
        const inputs = current === undefined ? null : await this.timerScheduleInputs([current.config], Date.now());
        const occurrence = current?.plannedOccurrence;
        if (inputs !== null && occurrence !== null && occurrence !== undefined) {
          const sendClaim = await readModuleAlarmSendClaim(this.ctx.storage, timerSkipReceiptKey(occurrence));
          if (this.timerScheduleInputGeneration !== inputGeneration) continue;
          if (sendClaim !== null) {
            if (sendClaim.status === "sent") {
              const completionClaim = this.ctx.storage.transactionSync(() => {
                const state = this.timerScheduleStateSync();
                const entry = state.timers[timerId];
                const consumedOccurrence = entry?.plannedOccurrence;
                if (entry === undefined || consumedOccurrence === null || consumedOccurrence === undefined ||
                    !sameTimerScheduledOccurrence(consumedOccurrence, occurrence)) return null;
                const retainedClaim = entry.inFlightClaim;
                const activityClaim = retainedClaim !== null &&
                  sameTimerScheduledOccurrence(retainedClaim.occurrence, consumedOccurrence)
                  ? retainedClaim
                  : {
                    occurrence: consumedOccurrence,
                    token: crypto.randomUUID(),
                    activityCount: state.activityCounts[consumedOccurrence.identity.state === "offline" ? "offline" : "live"],
                  };
                if (retainedClaim !== activityClaim) entry.inFlightClaim = activityClaim;
                return {
                  config: entry.config,
                  occurrence: consumedOccurrence,
                  token: activityClaim.token,
                  activityCount: activityClaim.activityCount,
                };
              });
              if (completionClaim === null) continue;
              await this.finishTimerOccurrence(timerId, completionClaim, true, inputs);
              continue;
            }
            const reconciled = this.ctx.storage.transactionSync(() => {
              if (this.timerScheduleInputGeneration !== inputGeneration) return false;
              const state = this.timerScheduleStateSync();
              const entry = state.timers[timerId];
              const consumedOccurrence = entry?.plannedOccurrence;
              if (entry === undefined || consumedOccurrence === null || consumedOccurrence === undefined ||
                  !sameTimerScheduledOccurrence(consumedOccurrence, occurrence)) return false;
              const now = Date.now();
              if (entry.config.trigger.type === "stream_start") {
                entry.completedStreamId = consumedOccurrence.identity.streamId;
              }
              const nextInputs = {
                ...inputs,
                now: Math.max(now, consumedOccurrence.identity.deadline),
              };
              const nextPlan = makeTimerPlan(entry.config, state.stream, consumedOccurrence, nextInputs,
                "after_occurrence", entry.completedStreamId ?? null);
              this.setTimerPlanSync(entry, nextPlan, state.stream, nextInputs);
              this.persistTimerScheduleSync(state, timerId, entry);
              return true;
            });
            if (!reconciled) continue;
            await this.writeTimerMirror(timerId);
            await this.scheduleEarliestAlarm();
            continue;
          }
        }
        const authorization = authorizeModuleMutation(channelId, actor, new Date().toISOString());
        const authorizationAndModule = await this.env.DB.prepare(
          `SELECT timer_module.enabled AS timers_module_enabled
             FROM channels
             LEFT JOIN channel_modules AS timer_module
               ON timer_module.channel_id = channels.channel_id AND timer_module.module_id = 'timers'
            WHERE channels.channel_id = ? ${authorization.sql}`,
        ).bind(channelId, ...authorization.values).first<{ timers_module_enabled: number | null }>();
        if (this.timerScheduleInputGeneration !== inputGeneration) continue;
        if (authorizationAndModule === null) {
          return { result: { result: "denied" }, mirrorChanged: false, auditOperationId: null };
        }
        if (authorizationAndModule.timers_module_enabled !== 1) {
          return { result: { result: "nothing_planned" }, mirrorChanged: false, auditOperationId: null };
        }

        const committed = this.ctx.storage.transactionSync(():
          TimerSkipOperationOutcome | { retryScheduleInputs: true } => {
          if (this.timerScheduleInputGeneration !== inputGeneration) return { retryScheduleInputs: true };
          const state = this.timerScheduleStateSync();
          const entry = state.timers[timerId];
          if (entry === undefined || entry.config.revision !== expectedRevision || inputs === null) {
            return { result: { result: "not_found" }, mirrorChanged: false, auditOperationId: null };
          }
          const occurrence = entry.plannedOccurrence;
          if (!entry.config.enabled || occurrence === null) {
            return { result: { result: "nothing_planned" }, mirrorChanged: false, auditOperationId: null };
          }

          const now = Date.now();
          const occurrenceKey = timerSkipReceiptKey(occurrence);
          const skipReceipts = timerSkipReceiptsForSchedule(entry, now, state.stream);
          entry.skipReceipts = skipReceipts;
          const receipt = skipReceipts.find((candidate) => candidate.occurrenceKey === occurrenceKey);
          const alreadySkipped = sameTimerScheduledOccurrence(entry.skippedOccurrence, occurrence) || receipt !== undefined;
          const skipAuditOperationId = entry.skipAuditOperationId ?? receipt?.auditOperationId ?? null;
          if (alreadySkipped && skipAuditOperationId !== null) {
            const pendingAuditId = state.pendingSkipAudits?.[skipAuditOperationId] === undefined
              ? null
              : skipAuditOperationId;
            return { result: { result: "already_skipped" }, mirrorChanged: false, auditOperationId: pendingAuditId };
          }

          const nextPlan = makeTimerPlan(
            entry.config,
            state.stream,
            occurrence,
            { ...inputs, now: Math.max(now, occurrence.identity.deadline) },
            "after_occurrence",
            entry.config.trigger.type === "stream_start" ? occurrence.identity.streamId : entry.completedStreamId ?? null,
          );
          const nextOccurrenceAt = nextPlan.identity === null ? null : new Date(nextPlan.identity.deadline).toISOString();
          const operationId = crypto.randomUUID();
          const changedAt = new Date().toISOString();
          const intent: TimerSkipAuditIntent = {
            operationId,
            actorUserId: actor.userId,
            changedAt,
            timerId,
            timerName: entry.config.name,
            timerRevision: entry.config.revision,
            skippedOccurrenceAt: new Date(occurrence.identity.deadline).toISOString(),
            nextOccurrenceAt,
            retryAttempt: 0,
          };
          state.pendingSkipAudits ??= {};
          state.pendingSkipAudits[operationId] = intent;
          if (receipt === undefined) {
            skipReceipts.push({ occurrenceKey, deadline: occurrence.identity.deadline, auditOperationId: operationId });
          } else {
            receipt.auditOperationId = operationId;
          }
          entry.skipReceipts = skipReceipts;
          entry.skippedOccurrence = occurrence;
          entry.effectiveNextOccurrence = nextPlan.identity === null
            ? null
            : { identity: nextPlan.identity, sequence: entry.planSequence + 1 };
          entry.planSequence += 1;
          entry.skipAuditOperationId = operationId;
          entry.mirrorSequence += 1;
          this.writeTimerSkipAuditAlarmSync(operationId, intent.retryAttempt, now + TIMER_MIRROR_RETRY_DELAY_MS);
          this.writeTimerDurableStateSync(state);
          return {
            result: alreadySkipped
              ? { result: "already_skipped" }
              : { result: "skipped", skippedOccurrenceAt: intent.skippedOccurrenceAt, nextOccurrenceAt },
            mirrorChanged: true,
            auditOperationId: operationId,
          };
        });
        if ("retryScheduleInputs" in committed) continue;
        return committed;
      }

      return { result: { result: "nothing_planned" }, mirrorChanged: false, auditOperationId: null };
    });

    const { result, mirrorChanged, auditOperationId } = outcome;
    if (result.result === "denied") return result;
    if (mirrorChanged) {
      await this.writeTimerMirror(timerId);
      await this.notifyCommittedPanelResources();
    }
    if (auditOperationId !== null) await this.deliverTimerSkipAudit(auditOperationId);
    await this.scheduleEarliestAlarm();
    return result;
  }

  private writeTimerSkipAuditAlarmSync(operationId: string, retryAttempt: number, deadline: number): void {
    const table = this.timerAlarmScheduleSync();
    const key = `${TIMER_ALARM_PREFIX}audit:${operationId}:${String(retryAttempt)}`;
    table[key] = {
      deadline,
      handler: TIMER_OCCURRENCE_HANDLER,
      revision: (table[key]?.revision ?? 0) + 1,
    };
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private clearTimerSkipAuditAlarmsSync(operationId: string): void {
    const table = this.timerAlarmScheduleSync();
    const prefix = `${TIMER_ALARM_PREFIX}audit:${operationId}:`;
    let changed = false;
    for (const key of Object.keys(table)) {
      if (!key.startsWith(prefix)) continue;
      Reflect.deleteProperty(table, key);
      changed = true;
    }
    if (changed) this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private async deliverTimerSkipAudit(operationId: string): Promise<void> {
    const intent = this.timerScheduleStateSync().pendingSkipAudits?.[operationId];
    if (intent === undefined) return;
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    try {
      await writeModuleAudit(this.env.DB, intent.actorUserId, intent.changedAt, {
        channelId,
        moduleId: "timers",
        action: "timers.timer.skipped",
        before: { timerId: intent.timerId, name: intent.timerName, revision: intent.timerRevision },
        after: {
          timerId: intent.timerId,
          skippedOccurrenceAt: intent.skippedOccurrenceAt,
          nextOccurrenceAt: intent.nextOccurrenceAt,
        },
      }, "member", { operationId, actorUserId: intent.actorUserId });
    } catch (error: unknown) {
      console.warn("Timer skip audit delivery failed and will be retried.", operationId, error);
      this.ctx.storage.transactionSync(() => {
        const state = this.timerScheduleStateSync();
        const current = state.pendingSkipAudits?.[operationId];
        if (current === undefined) return;
        current.retryAttempt += 1;
        this.clearTimerSkipAuditAlarmsSync(operationId);
        this.writeTimerSkipAuditAlarmSync(operationId, current.retryAttempt,
          Date.now() + TIMER_MIRROR_RETRY_DELAY_MS);
        this.writeTimerDurableStateSync(state);
      });
      await this.scheduleEarliestAlarm();
      return;
    }

    this.ctx.storage.transactionSync(() => {
      const state = this.timerScheduleStateSync();
      if (state.pendingSkipAudits?.[operationId] === undefined) return;
      Reflect.deleteProperty(state.pendingSkipAudits, operationId);
      this.writeTimerDurableStateSync(state);
      this.clearTimerSkipAuditAlarmsSync(operationId);
    });
    await this.scheduleEarliestAlarm();
  }

  private async withTimerOccurrenceOperation<Result>(timerId: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.timerOccurrenceQueues.get(timerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.timerOccurrenceQueues.set(timerId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.timerOccurrenceQueues.get(timerId) === current) this.timerOccurrenceQueues.delete(timerId);
    }
  }

  /** Removes a committed D1 timer and fences any config snapshot read before its delete. */
  public async deleteTimerConfig(timerId: string, expectedRevision: number): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ensureTimerSchedulesInitialized();
    await this.transitionTimerStream(await this.readTimerStreamFromDatabase());
    const changed = this.ctx.storage.transactionSync(() => {
      const state = this.timerScheduleStateSync();
      const current = state.timers[timerId];
      if (current !== undefined && current.config.revision > expectedRevision) return false;
      const revision = Math.max(state.tombstones[timerId]?.revision ?? 0, expectedRevision + 1);
      Reflect.deleteProperty(state.tombstones, timerId);
      state.tombstones[timerId] = { revision, deletedAt: Date.now() };
      this.pruneTimerTombstonesSync(state);
      this.persistTimerScheduleSync(state, timerId);
      return true;
    });
    if (changed) await this.clearTimerMirrorRetryAlarms(timerId);
    await this.scheduleEarliestAlarm();
  }

  /** Commits an accepted EventSub or Helix stream transition before replanning stream-scoped timers. */
  public async transitionTimerStream(stream: DurableTimerStream): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ensureTimerSchedulesInitialized();
    if (stream.endedSession !== undefined &&
        !(stream.state === "online" && stream.streamId === stream.endedSession.streamId &&
          sameStreamStartedAt(stream.startedAt, stream.endedSession.startedAt))) {
      await this.markStatisticsClipImportPending(
        stream.endedSession.streamId,
        stream.endedSession.startedAt,
        stream.endedSession.endedAt,
      );
      await this.ensureStatisticsWindowAlarmScheduled(Date.now());
    }
    const now = Date.now();
    const changedTimerIds: string[] = [];
    this.ctx.storage.transactionSync(() => {
      const state = this.timerScheduleStateSync();
      if (stream.generation < state.stream.generation) return;
      const streamChanged = stream.generation > state.stream.generation || stream.state !== state.stream.state ||
        stream.streamId !== state.stream.streamId || !sameStreamStartedAt(stream.startedAt, state.stream.startedAt);
      if (!streamChanged) return;
      this.timerScheduleInputGeneration += 1;
      state.stream = {
        state: stream.state,
        streamId: stream.streamId,
        startedAt: stream.startedAt,
        generation: stream.generation,
      };
      if (stream.state === "online") state.activityCounts.live = 0;
      if (stream.state === "offline") state.activityCounts.offline = 0;
      const inputs: TimerScheduleInputs = { now, timeZone: "Europe/Berlin", eventTimes: [] };
      for (const [timerId, entry] of Object.entries(state.timers)) {
        if (entry.config.trigger.type !== "interval" && entry.config.trigger.type !== "stream_start") continue;
        if (entry.config.trigger.type === "interval") entry.activityBaselines = { ...state.activityCounts };
        this.setTimerPlanSync(entry,
          makeTimerPlan(entry.config, state.stream, entry.plannedOccurrence, inputs, "reset", entry.completedStreamId),
        state.stream, inputs);
        this.writeTimerAlarmEntriesSync(timerId, entry);
        changedTimerIds.push(timerId);
      }
      this.writeTimerDurableStateSync(state);
    });
    await Promise.all(changedTimerIds.map((timerId) => this.writeTimerMirror(timerId)));
    if (changedTimerIds.some((timerId) => {
      const entry = this.timerScheduleStateSync().timers[timerId];
      return entry !== undefined && sameTimerScheduledOccurrence(entry.skippedOccurrence, entry.plannedOccurrence);
    })) await this.notifyCommittedPanelResources();
    await this.scheduleEarliestAlarm();
  }

  /** Replans host-owned timer inputs after activation, timezone, event-time, or repair notifications. */
  public async reconcileTimerSchedules(reason: ModuleScheduleInputChangeReason): Promise<void> {
    await this.ensurePointRoundRecovery();
    const previous = this.timerScheduleReconciliationQueue;
    let release!: () => void;
    this.timerScheduleReconciliationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.reconcileTimerSchedulesSerial(reason);
    } finally {
      release();
    }
  }

  private async reconcileTimerSchedulesSerial(reason: ModuleScheduleInputChangeReason): Promise<void> {
    if (reason === "stream_state") {
      await this.transitionTimerStream(await this.readTimerStreamFromDatabase());
      return;
    }
    await this.ensureTimerSchedulesInitialized();
    const timerRevisionsBeforeRead = new Map(Object.entries(this.timerScheduleStateSync().timers)
      .map(([timerId, entry]) => [timerId, entry.config.revision]));
    const [configs, databaseStream] = await Promise.all([
      this.readTimerConfigsFromDatabase(),
      this.readTimerStreamFromDatabase(),
    ]);
    const inputs = await this.timerScheduleInputs(configs, Date.now());
    const changedTimerIds: string[] = [];
    this.ctx.storage.transactionSync(() => {
      this.timerScheduleInputGeneration += 1;
      const state = this.timerScheduleStateSync();
      let streamChanged = false;
      if (databaseStream.generation >= state.stream.generation) {
        streamChanged = databaseStream.generation > state.stream.generation ||
          databaseStream.state !== state.stream.state || databaseStream.streamId !== state.stream.streamId ||
          !sameStreamStartedAt(databaseStream.startedAt, state.stream.startedAt);
        state.stream = databaseStream;
        if (streamChanged && databaseStream.state === "online") state.activityCounts.live = 0;
        if (streamChanged && databaseStream.state === "offline") state.activityCounts.offline = 0;
      }
      if (streamChanged) {
        const transitionInputs: TimerScheduleInputs = {
          now: inputs.now,
          timeZone: inputs.timeZone,
          eventTimes: [],
        };
        for (const [timerId, entry] of Object.entries(state.timers)) {
          if (entry.config.trigger.type !== "interval" && entry.config.trigger.type !== "stream_start") continue;
          if (entry.config.trigger.type === "interval") entry.activityBaselines = { ...state.activityCounts };
          this.setTimerPlanSync(entry,
            makeTimerPlan(entry.config, state.stream, entry.plannedOccurrence, transitionInputs,
              "reset", entry.completedStreamId), state.stream, transitionInputs);
          this.persistTimerScheduleSync(state, timerId, entry);
          changedTimerIds.push(timerId);
        }
      }
      for (const config of configs) {
        if (this.timerTombstoneRevision(state, config.id) >= config.revision) continue;
        const current = state.timers[config.id];
        if (current !== undefined && current.config.revision > config.revision) continue;
        const configChanged = current === undefined || current.config.revision < config.revision;
        const entry = current ?? this.newDurableTimerEntry(config, state);
        const previousTriggerType = current?.config.trigger.type;
        const triggerChanged = current === undefined || JSON.stringify(current.config.trigger) !== JSON.stringify(config.trigger);
        entry.config = config;
        const skippedOccurrenceIsPlanned = sameTimerScheduledOccurrence(current?.skippedOccurrence, current?.plannedOccurrence);
        const preserveSkippedOccurrence = skippedOccurrenceIsPlanned && previousTriggerType === config.trigger.type;
        const relevantInputChanged = (reason === "channel_time_zone" &&
          (config.trigger.type === "time_of_day" || config.trigger.type === "before_event")) ||
          (reason === "event_times" && config.trigger.type === "before_event");
        if (!configChanged && !relevantInputChanged) continue;
        if (configChanged && triggerChanged && (previousTriggerType === "interval" || config.trigger.type === "interval")) {
          entry.activityBaselines = { ...state.activityCounts };
        }
        const plan = makeTimerPlan(config, state.stream, entry.plannedOccurrence, inputs,
          (triggerChanged || relevantInputChanged) && !preserveSkippedOccurrence ? "reset" : "preserve_cadence",
          entry.completedStreamId);
        const sameIdentity = plan.identity === null
          ? entry.plannedOccurrence === null
          : sameTimerAlarmIdentity(entry.plannedOccurrence?.identity, plan.identity);
        const refreshEffectivePlan = relevantInputChanged && skippedOccurrenceIsPlanned;
        if (!configChanged && sameIdentity && entry.refreshAt === plan.refreshAt && !refreshEffectivePlan) continue;
        this.setTimerPlanSync(entry, plan, state.stream, inputs);
        this.persistTimerScheduleSync(state, config.id, entry);
        changedTimerIds.push(config.id);
      }
      const currentConfigIds = new Set(configs.map((config) => config.id));
      for (const [timerId, entry] of Object.entries(state.timers)) {
        if (currentConfigIds.has(timerId)) continue;
        if (timerRevisionsBeforeRead.get(timerId) !== entry.config.revision) continue;
        const revision = Math.max(state.tombstones[timerId]?.revision ?? 0, entry.config.revision + 1);
        Reflect.deleteProperty(state.tombstones, timerId);
        state.tombstones[timerId] = { revision, deletedAt: Date.now() };
        this.pruneTimerTombstonesSync(state);
        this.persistTimerScheduleSync(state, timerId);
        changedTimerIds.push(timerId);
      }
      state.initialized = true;
      this.writeTimerDurableStateSync(state);
    });
    const timerIdsToMirror = new Set([...changedTimerIds, ...Object.keys(this.timerScheduleStateSync().timers)]);
    await Promise.all([...timerIdsToMirror].map((timerId) =>
      this.timerScheduleStateSync().timers[timerId] === undefined
        ? this.clearTimerMirrorRetryAlarms(timerId)
        : this.writeTimerMirror(timerId)));
    if (changedTimerIds.some((timerId) => {
      const entry = this.timerScheduleStateSync().timers[timerId];
      return entry !== undefined && sameTimerScheduledOccurrence(entry.skippedOccurrence, entry.plannedOccurrence);
    })) await this.notifyCommittedPanelResources();
    await this.scheduleEarliestAlarm();
  }

  private async clearTimerMirrorRetryAlarms(timerId: string, throughSequence = Number.POSITIVE_INFINITY): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const table = this.timerAlarmScheduleSync();
      const prefix = `${TIMER_ALARM_PREFIX}mirror:${timerId}:`;
      let changed = false;
      for (const key of Object.keys(table)) {
        if (!key.startsWith(prefix)) continue;
        const sequence = Number(key.slice(prefix.length));
        if (!Number.isSafeInteger(sequence) || sequence > throughSequence) continue;
        Reflect.deleteProperty(table, key);
        changed = true;
      }
      if (changed) this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
    });
    await this.scheduleEarliestAlarm();
  }

  private async writeTimerMirror(timerId: string): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    const entry = this.timerScheduleStateSync().timers[timerId];
    if (entry === undefined) return;
    const skippedOccurrenceIsPlanned = sameTimerScheduledOccurrence(entry.skippedOccurrence, entry.plannedOccurrence);
    const occurrence = (skippedOccurrenceIsPlanned ? entry.effectiveNextOccurrence : entry.plannedOccurrence)?.identity;
    try {
      await this.env.DB.prepare(
        `UPDATE timers
            SET next_run_at = ?, next_run_state = ?, last_run_at = COALESCE(?, last_run_at),
                schedule_mirror_sequence = ?
          WHERE channel_id = ? AND timer_id = ? AND revision = ? AND schedule_mirror_sequence < ?`,
      ).bind(
        occurrence === undefined ? null : new Date(occurrence.deadline).toISOString(),
        occurrence?.state === "live" || occurrence?.state === "offline" ? occurrence.state : null,
        entry.lastRunAt,
        entry.mirrorSequence,
        channelId,
        timerId,
        entry.config.revision,
        entry.mirrorSequence,
      ).run();
      await this.clearTimerMirrorRetryAlarms(timerId, entry.mirrorSequence);
      const current = this.timerScheduleStateSync().timers[timerId];
      if (current !== undefined && current.mirrorSequence > entry.mirrorSequence) {
        await this.writeTimerMirror(timerId);
      }
    } catch (error: unknown) {
      console.warn("Timer schedule display mirror could not be updated.", timerId, error);
      this.ctx.storage.transactionSync(() => {
        const current = this.timerScheduleStateSync().timers[timerId];
        if (current === undefined || current.mirrorSequence !== entry.mirrorSequence) return;
        this.writeTimerMirrorRetryAlarmSync(timerId, entry.mirrorSequence, Date.now() + TIMER_MIRROR_RETRY_DELAY_MS);
      });
      await this.scheduleEarliestAlarm();
    }
  }

  private timerClaimIsCurrentSync(timerId: string, token: string, occurrence: TimerOccurrence): boolean {
    const entry = this.timerScheduleStateSync().timers[timerId];
    return entry !== undefined && entry.config.enabled && entry.inFlightClaim?.token === token &&
      sameTimerOccurrence(entry.inFlightClaim.occurrence, occurrence) &&
      sameTimerOccurrence(entry.plannedOccurrence, occurrence);
  }

  private async timerConfigIsEnabledAtRevision(timerId: string, revision: number): Promise<boolean> {
    const channelId = this.ownChannelId();
    if (channelId === null) return false;
    const row = await this.env.DB.prepare(
      `SELECT 1 AS timer_is_current FROM timers
        WHERE channel_id = ? AND timer_id = ? AND enabled = 1 AND revision = ?`,
    ).bind(channelId, timerId, revision).first<{ timer_is_current: number }>();
    return row?.timer_is_current === 1;
  }

  /** Final send fence: D1 may have recorded a stream transition the DO has not applied yet. */
  private async timerOccurrenceMatchesCommittedStream(occurrence: TimerOccurrence): Promise<boolean> {
    const channelId = this.ownChannelId();
    if (channelId === null) return false;
    const { identity } = occurrence;
    const live = identity.triggerType === "interval" ? identity.state === "live" : identity.triggerType === "stream_start";
    const offlineInterval = identity.triggerType === "interval" && identity.state === "offline";
    const liveOnlyDaily = this.timerConfigAlsoOfflineIsFalseDaily(identity);
    if (!live && !offlineInterval && !liveOnlyDaily) return true;
    const stored = await readChannelStreamState(this.env.DB, channelId);
    if (stored === null) return false;
    if (offlineInterval) return stored.state === "offline";
    if (stored.state !== "online") return false;
    return !(live && identity.triggerType !== "time_of_day") || stored.streamId === null ||
      identity.streamId === null || stored.streamId === identity.streamId;
  }

  private timerConfigAlsoOfflineIsFalseDaily(identity: TimerOccurrence["identity"]): boolean {
    if (identity.triggerType !== "time_of_day") return false;
    const config = this.timerScheduleStateSync().timers[identity.timerId]?.config;
    return config?.trigger.type === "time_of_day" && !config.trigger.alsoOffline;
  }

  private timerStreamMatchesOccurrence(stream: DurableTimerStream, occurrence: TimerOccurrence): boolean {
    const { identity } = occurrence;
    if (identity.triggerType === "interval") {
      return identity.state === "offline"
        ? stream.state === "offline" && stream.generation === identity.generation
        : identity.state === "live" && stream.state === "online" && stream.streamId === identity.streamId &&
          stream.generation === identity.generation;
    }
    if (identity.triggerType === "stream_start") {
      return stream.state === "online" && stream.streamId === identity.streamId && stream.generation === identity.generation;
    }
    return true;
  }

  private async refreshTimerPlanFromAlarm(
    timerId: string,
    deadline: number,
    ownerRevision: number | undefined,
  ): Promise<void> {
    const current = this.timerScheduleStateSync().timers[timerId];
    if (current === undefined || current.refreshAt !== deadline ||
        ownerRevision !== undefined && current.config.revision !== ownerRevision) return;
    const inputs = await this.timerScheduleInputs([current.config], Date.now());
    const changed = this.ctx.storage.transactionSync(() => {
      const state = this.timerScheduleStateSync();
      const entry = state.timers[timerId];
      if (entry === undefined || entry.refreshAt !== deadline || entry.config.revision !== current.config.revision) return false;
      const plan = makeTimerPlan(entry.config, state.stream, entry.plannedOccurrence, inputs, "preserve_cadence",
        entry.completedStreamId);
      const sameIdentity = plan.identity === null
        ? entry.plannedOccurrence === null
        : sameTimerAlarmIdentity(entry.plannedOccurrence?.identity, plan.identity);
      if (sameIdentity && entry.refreshAt === plan.refreshAt) return false;
      this.setTimerPlanSync(entry, plan, state.stream, inputs);
      this.persistTimerScheduleSync(state, timerId, entry);
      return true;
    });
    if (changed) {
      await this.writeTimerMirror(timerId);
      const entry = this.timerScheduleStateSync().timers[timerId];
      if (entry !== undefined && sameTimerScheduledOccurrence(entry.skippedOccurrence, entry.plannedOccurrence)) {
        await this.notifyCommittedPanelResources();
      }
    }
    await this.scheduleEarliestAlarm();
  }

  public async runTimerOccurrence(
    context: ModuleAlarmContext,
    key: string,
    deadline: number,
    ownerRevision?: number,
    identity?: ModuleAlarmIdentity | null,
    planSequence?: number,
  ): Promise<"retain" | undefined> {
    if (key.startsWith("mirror:")) return await this.runTimerOccurrenceSerial(context, key, deadline, ownerRevision, identity, planSequence);
    const refreshMarker = ":refresh:";
    const refreshAt = key.indexOf(refreshMarker);
    const timerId = key.startsWith("timer:")
      ? key.slice("timer:".length, refreshAt < 0 ? undefined : refreshAt)
      : "";
    if (timerId.length === 0) return await this.runTimerOccurrenceSerial(context, key, deadline, ownerRevision, identity, planSequence);
    return await this.withTimerOccurrenceOperation(timerId,
      () => this.runTimerOccurrenceSerial(context, key, deadline, ownerRevision, identity, planSequence));
  }

  private async runTimerOccurrenceSerial(
    context: ModuleAlarmContext,
    key: string,
    deadline: number,
    ownerRevision?: number,
    identity?: ModuleAlarmIdentity | null,
    planSequence?: number,
  ): Promise<"retain" | undefined> {
    await this.ensurePointRoundRecovery();
    if (key.startsWith("audit:")) {
      const operationId = key.slice("audit:".length).split(":")[0] ?? "";
      if (operationId.length > 0) await this.deliverTimerSkipAudit(operationId);
      return;
    }
    if (key.startsWith("mirror:")) {
      const timerId = key.slice("mirror:".length).split(":")[0] ?? "";
      if (timerId.length > 0) {
        await this.writeTimerMirror(timerId);
        await this.notifyCommittedPanelResources();
      }
      return;
    }
    const refreshMarker = ":refresh:";
    const refreshAt = key.indexOf(refreshMarker);
    const timerId = key.startsWith("timer:")
      ? key.slice("timer:".length, refreshAt < 0 ? undefined : refreshAt)
      : "";
    if (timerId.length === 0) return;
    if (refreshAt >= 0) {
      await this.refreshTimerPlanFromAlarm(timerId, deadline, ownerRevision);
      return;
    }
    if (identity === undefined || identity === null || planSequence === undefined) return;
    await this.ensureTimerSchedulesInitialized();
    await this.refreshTimerOccurrenceSnapshot(timerId);

    const claimed = this.ctx.storage.transactionSync((): {
      config: DurableTimerConfig;
      occurrence: TimerOccurrence;
      token: string;
      activityCount: number;
      skipped: boolean;
    } | null => {
      const state = this.timerScheduleStateSync();
      const entry = state.timers[timerId];
      const currentOccurrence = entry?.plannedOccurrence;
      if (entry === undefined || !entry.config.enabled || currentOccurrence === null || currentOccurrence === undefined ||
          entry.config.revision !== identity.revision || ownerRevision !== undefined && entry.config.revision !== ownerRevision ||
          deadline !== identity.deadline || currentOccurrence.sequence !== planSequence ||
          !sameTimerAlarmIdentity(currentOccurrence.identity, identity) || deadline > Date.now()) return null;
      const occurrence = { identity: currentOccurrence.identity, sequence: currentOccurrence.sequence };
      const token = crypto.randomUUID();
      const streamState = identity.state === "live" ? "live" : identity.state === "offline" ? "offline" : null;
      const activityCount = streamState === null ? 0 : state.activityCounts[streamState];
      const skipped = sameTimerScheduledOccurrence(entry.skippedOccurrence, occurrence);
      entry.inFlightClaim = { occurrence, token, activityCount };
      this.writeTimerDurableStateSync(state);
      return { config: entry.config, occurrence, token, activityCount, skipped };
    });
    if (claimed === null) return;

    const planInputs = await this.timerScheduleInputs([claimed.config], Date.now());
    if (!this.timerClaimIsCurrentSync(timerId, claimed.token, claimed.occurrence)) return;
    if (claimed.skipped) {
      await this.finishTimerOccurrence(timerId, claimed, false, planInputs);
      return;
    }
    const now = Date.now();
    const trigger = claimed.config.trigger;
    const intervalState: TimerIntervalState | null = trigger.type === "interval" &&
      (claimed.occurrence.identity.state === "live" || claimed.occurrence.identity.state === "offline")
      ? claimed.occurrence.identity.state
      : null;
    if (trigger.type === "interval" && intervalState === null) return;
    const minimumMessages = trigger.type === "interval" && intervalState !== null
      ? trigger[intervalState]?.minimumMessages
      : undefined;
    const activityBaseline = intervalState === "live" || intervalState === "offline"
      ? this.timerScheduleStateSync().timers[timerId]?.activityBaselines[intervalState] ?? claimed.activityCount
      : claimed.activityCount;
    const enoughActivity = minimumMessages === undefined || claimed.activityCount - activityBaseline >= minimumMessages;
    if (!this.timerStreamMatchesOccurrence(this.timerScheduleStateSync().stream, claimed.occurrence)) return;

    let matchingEventAt: number | undefined;
    let validOccurrence = true;
    if (trigger.type === "before_event") {
      const event = planInputs.eventTimes.find((candidate) => candidate.id === trigger.sourceId &&
        Date.parse(candidate.at) - trigger.minutes * 60_000 === deadline);
      validOccurrence = event !== undefined;
      if (event !== undefined) matchingEventAt = Date.parse(event.at);
    } else if (trigger.type === "time_of_day") {
      validOccurrence = isDailyTimerDeadlineCurrent(trigger, deadline, planInputs.timeZone);
    }

    const graceEndsAt = trigger.type === "before_event"
      ? matchingEventAt ?? deadline
      : deadline + TIMER_OCCURRENCE_GRACE_MS;
    const withinGrace = now <= graceEndsAt;
    const streamEligible = trigger.type !== "time_of_day" || trigger.alsoOffline ||
      this.timerScheduleStateSync().stream.state === "online";
    const shouldSend = validOccurrence && withinGrace && enoughActivity && streamEligible &&
      this.timerClaimIsCurrentSync(timerId, claimed.token, claimed.occurrence);
    let sent = false;
    let sendReason: string | null = null;
    if (shouldSend) {
      const rendered = await context.renderTemplate(claimed.config.messageText, now);
      if (!this.timerClaimIsCurrentSync(timerId, claimed.token, claimed.occurrence)) return;
      const streamId = claimed.occurrence.identity.streamId ?? undefined;
      // A stream_start post is identified by (timer, stream), never by its deadline.
      const idempotencyKey = trigger.type === "stream_start" && streamId !== undefined
        ? streamStartIdempotencyKey(timerId, streamId)
        : timerOccurrenceKey(timerId, deadline, streamId);
      const result = await context.sendChat(
        rendered.text,
        idempotencyKey,
        rendered.attributions,
        async () => {
          if (!this.timerClaimIsCurrentSync(timerId, claimed.token, claimed.occurrence) || Date.now() > graceEndsAt ||
              trigger.type === "time_of_day" && !trigger.alsoOffline && this.timerScheduleStateSync().stream.state !== "online") {
            return false;
          }
          const databaseCurrent = await this.timerConfigIsEnabledAtRevision(timerId, claimed.config.revision) &&
            await this.timerOccurrenceMatchesCommittedStream(claimed.occurrence);
          return databaseCurrent && this.timerClaimIsCurrentSync(timerId, claimed.token, claimed.occurrence) &&
            Date.now() <= graceEndsAt &&
            (trigger.type !== "time_of_day" || trigger.alsoOffline || this.timerScheduleStateSync().stream.state === "online");
        },
        claimed.config.chatTarget ?? undefined,
      );
      sent = result.sent;
      sendReason = result.reason;
      if (!result.sent && result.retryable) throw new Error(`Timer chat send failed: ${result.reason ?? "unknown"}.`);
      if (!result.sent && result.reason === "stale_before_send" &&
          this.timerClaimIsCurrentSync(timerId, claimed.token, claimed.occurrence)) return "retain";
    }

    if (!validOccurrence && this.timerClaimIsCurrentSync(timerId, claimed.token, claimed.occurrence)) {
      await this.finishTimerOccurrence(timerId, claimed, false, planInputs);
      return;
    }
    if (!withinGrace && this.timerClaimIsCurrentSync(timerId, claimed.token, claimed.occurrence)) {
      await this.finishTimerOccurrence(timerId, claimed, false, planInputs);
      return;
    }
    if (!enoughActivity || sent || sendReason !== "stale_before_send") {
      await this.finishTimerOccurrence(timerId, claimed, sent, planInputs);
    }
  }

  private async finishTimerOccurrence(
    timerId: string,
    claim: { config: DurableTimerConfig; occurrence: TimerOccurrence; token: string; activityCount: number },
    sent: boolean,
    inputs: TimerScheduleInputs,
  ): Promise<void> {
    const now = Date.now();
    const finished = this.ctx.storage.transactionSync(() => {
      const state = this.timerScheduleStateSync();
      const entry = state.timers[timerId];
      if (entry === undefined || entry.config.revision !== claim.config.revision ||
          entry.inFlightClaim?.token !== claim.token ||
          !sameTimerScheduledOccurrence(entry.inFlightClaim.occurrence, claim.occurrence) ||
          !sameTimerScheduledOccurrence(entry.plannedOccurrence, claim.occurrence)) return false;
      const trigger = entry.config.trigger;
      if (sent && trigger.type === "interval" &&
          (claim.occurrence.identity.state === "live" || claim.occurrence.identity.state === "offline")) {
        entry.activityBaselines[claim.occurrence.identity.state] = claim.activityCount;
      }
      if (sent) entry.lastRunAt = new Date(now).toISOString();
      if (sameTimerScheduledOccurrence(entry.skippedOccurrence, claim.occurrence)) {
        const occurrenceKey = timerSkipReceiptKey(claim.occurrence);
        entry.skipReceipts = (entry.skipReceipts ?? []).filter((receipt) => receipt.occurrenceKey !== occurrenceKey);
        entry.skippedOccurrence = null;
        entry.skipAuditOperationId = null;
      }
      const nextInputs = { ...inputs, now };
      if (trigger.type === "stream_start") entry.completedStreamId = claim.occurrence.identity.streamId;
      const plan = makeTimerPlan(entry.config, state.stream, entry.plannedOccurrence, nextInputs,
        "after_occurrence", entry.completedStreamId);
      this.setTimerPlanSync(entry, plan, state.stream, nextInputs);
      this.persistTimerScheduleSync(state, timerId, entry);
      return true;
    });
    if (!finished) return;
    await this.writeTimerMirror(timerId);
    await this.scheduleEarliestAlarm();
  }

  private writeActiveChatterExpiryEntrySync(deadline: number): void {
    const saved = this.ctx.storage.kv.get(ALARM_TABLE_KEY);
    const table: AlarmScheduleTable = {};
    if (isRecord(saved)) {
      for (const [key, value] of Object.entries(saved)) {
        if (validAlarmScheduleEntry(value)) table[key] = value;
      }
    }
    const current = table[ACTIVE_CHATTER_EXPIRY_KEY];
    if (current?.handler === ACTIVE_CHATTER_EXPIRY_HANDLER && current.deadline === deadline &&
        current.nextAttemptAt === undefined && current.claimUntil === undefined) return;
    table[ACTIVE_CHATTER_EXPIRY_KEY] = {
      deadline,
      handler: ACTIVE_CHATTER_EXPIRY_HANDLER,
      revision: (current?.revision ?? 0) + 1,
    };
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private clearActiveChatterExpiryEntrySync(): void {
    const saved = this.ctx.storage.kv.get(ALARM_TABLE_KEY);
    if (!isRecord(saved)) return;
    const table: AlarmScheduleTable = {};
    for (const [key, value] of Object.entries(saved)) {
      if (validAlarmScheduleEntry(value)) table[key] = value;
    }
    const current = table[ACTIVE_CHATTER_EXPIRY_KEY];
    if (current === undefined) return;
    Reflect.deleteProperty(table, ACTIVE_CHATTER_EXPIRY_KEY);
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private clearActiveChatterRecordsSync(): void {
    this.ensureActiveChatterTable();
    this.ctx.storage.sql.exec(`DELETE FROM ${ACTIVE_CHATTER_TABLE}`);
  }

  private activeChatterKeyRowSync(): { keyHex: string; createdAt: number } | null {
    this.ensureActiveChatterTable();
    const row = this.ctx.storage.sql.exec<{ key_hex: string; created_at: string }>(
      `SELECT key_hex, created_at FROM ${ACTIVE_CHATTER_KEY_TABLE} WHERE slot = 1`,
    ).toArray()[0];
    if (row === undefined || !/^[0-9a-f]{64}$/iu.test(row.key_hex)) return null;
    const createdAt = Date.parse(row.created_at);
    return Number.isFinite(createdAt) ? { keyHex: row.key_hex, createdAt } : null;
  }

  private activeChatterKeyRowSnapshot(): { keyHex: string; createdAt: number } | null {
    try {
      const row = this.ctx.storage.sql.exec<{ key_hex: string; created_at: string }>(
        `SELECT key_hex, created_at FROM ${ACTIVE_CHATTER_KEY_TABLE} WHERE slot = 1`,
      ).toArray()[0];
      if (row === undefined || !/^[0-9a-f]{64}$/iu.test(row.key_hex)) return null;
      const createdAt = Date.parse(row.created_at);
      return Number.isFinite(createdAt) ? { keyHex: row.key_hex, createdAt } : null;
    } catch {
      return null;
    }
  }

  private activeChatterNextSweepSync(keyCreatedAt: number): number | null {
    this.ensureActiveChatterTable();
    const row = this.ctx.storage.sql.exec<{ first_expiry: string | null }>(
      `SELECT MIN(last_seen_at) AS first_expiry FROM ${ACTIVE_CHATTER_TABLE}`,
    ).toArray()[0];
    if (row?.first_expiry == null) return null;
    const firstSeen = Date.parse(row.first_expiry);
    if (!Number.isFinite(firstSeen)) return Date.now();
    return Math.min(firstSeen + ACTIVE_CHATTER_RETENTION_MS, keyCreatedAt + ACTIVE_CHATTER_KEY_ROTATION_MS);
  }

  private recordActiveChatter(hmac: string, seenAt: string): void {
    this.ensureActiveChatterTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO ${ACTIVE_CHATTER_TABLE} (hmac, first_seen_at, last_seen_at)
       VALUES (?, ?, ?)
       ON CONFLICT(hmac) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      hmac,
      seenAt,
      seenAt,
    );
  }

  private ensureStatisticsWindowSync(windowStart: number, streamId: string | null): void {
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO ${STATISTICS_CHAT_WINDOW_TABLE} (window_start, stream_id)
       VALUES (?, ?)`,
      windowStart,
      streamId,
    );
  }

  private activeChattersAtBoundarySync(boundary: number): number | null {
    this.ensureActiveChatterTable();
    const key = this.activeChatterKeyRowSync();
    if (key === null || key.createdAt > boundary || boundary - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) {
      return null;
    }
    return this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${ACTIVE_CHATTER_TABLE}
        WHERE last_seen_at >= ? AND last_seen_at < ?`,
      new Date(boundary - STATISTICS_WINDOW_MILLISECONDS).toISOString(),
      new Date(boundary).toISOString(),
    ).one().count;
  }

  private async ensureStatisticsWindowAlarmScheduled(now: number): Promise<void> {
    const deadline = await this.getModuleAlarmDeadline("statistics", "window");
    if (deadline !== null) return;
    await this.scheduleModuleAlarm(
      "statistics",
      "window",
      "window",
      statisticsWindowStartMs(now) + STATISTICS_WINDOW_MILLISECONDS,
    );
  }

  /** Arm a physical alarm before committing a new or earlier sweep deadline. */
  private async ensurePlatformActiveChatterAlarm(deadline: number): Promise<void> {
    const platformAlarm = await this.ctx.storage.getAlarm();
    if (platformAlarm === null || platformAlarm > deadline) await this.ctx.storage.setAlarm(deadline);
  }

  private clearActiveChatterStateSync(): void {
    this.clearActiveChatterRecordsSync();
    this.ctx.storage.sql.exec(`DELETE FROM ${ACTIVE_CHATTER_KEY_TABLE}`);
    this.ctx.storage.kv.delete(LEGACY_ACTIVE_CHATTER_STREAM_KEY);
    this.clearActiveChatterExpiryEntrySync();
  }

  /** Keep schedule cache writes and their alarm reconciliation in one order. */
  private async withAdScheduleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.adScheduleOperationQueue;
    let release!: () => void;
    this.adScheduleOperationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async saveAdSchedule(
    schedule: AdsSchedule,
    asOf: string,
    grantedScopes?: readonly string[],
    expectedGeneration?: number,
    reconcileAlarm = true,
  ): Promise<boolean | null> {
    return this.withAdScheduleOperation(async () => {
      const channelId = this.ownChannelId();
      if (channelId === null) throw new Error("Channel-bound data requires a named Durable Object.");
      const cache = { schedule, asOf } satisfies CachedAdSchedule;
      const countdownState = adCountdownStateForSchedule(schedule, asOf);
      const change = await this.ctx.storage.transaction(async (transaction) => {
        const currentGeneration = await transaction.get<number>(AD_SCHEDULE_GENERATION_KEY) ?? 0;
        if (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) return null;
        const previous = await transaction.get<CachedAdSchedule>(AD_SCHEDULE_CACHE_KEY);
        const previousCountdownState = previous === undefined ? null : adCountdownStateForSchedule(previous.schedule, previous.asOf);
        await transaction.put(AD_SCHEDULE_GENERATION_KEY, currentGeneration + 1);
        await transaction.put(AD_SCHEDULE_CACHE_KEY, cache);
        await bumpDurablePanelResources(transaction, ["module:ads:schedule"]);
        return {
          changed: previous === undefined || JSON.stringify(previous.schedule) !== JSON.stringify(schedule),
          countdownChanged: previousCountdownState === null ||
            previousCountdownState.nextAdAt !== countdownState.nextAdAt ||
            previousCountdownState.duration !== countdownState.duration ||
            previousCountdownState.snoozeCount !== countdownState.snoozeCount ||
            previousCountdownState.snoozeRefreshAt !== countdownState.snoozeRefreshAt,
        };
      });
      if (change === null) return null;
      await this.notifyCommittedPanelResources();
      if (reconcileAlarm) await this.reconcileAdPrewarning(schedule, grantedScopes);
      try {
        await writeAdCountdownState(this.env.DB, channelId, countdownState, asOf);
      } catch (error: unknown) {
        console.warn("Ad countdown state snapshot could not be stored.", error);
      } finally {
        await this.notifyCommittedPanelResources();
      }
      if (change.changed) await this.notifyScheduleInputsChanged("event_times");
      await this.reconcileAdCountdownRefresh(schedule);
      if (change.countdownChanged) {
        try {
          const publishedAt = new Date().toISOString();
          const prepared = await prepareModuleOverlayRealtimeMessage(
            this.env.DB,
            channelId,
            "ads",
            createAdCountdownOverlayAction({ ...countdownState, serverNow: publishedAt }),
          );
          if (prepared.outcome === "ready") await this.publish([prepared.message]);
        } catch (error: unknown) {
          console.warn("Ad countdown overlay update could not be sent.", error);
        }
      }
      return change.changed;
    });
  }

  public async reconcileCachedAdPrewarning(grantedScopes?: readonly string[]): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.withAdScheduleOperation(async () => {
      // Read after entering the queue: an EventSub or Helix schedule save that
      // was queued first must be the value reconciled by this panel read.
      const cache = await this.getCachedAdSchedule();
      if (cache !== null) await this.reconcileAdPrewarning(cache.schedule, grantedScopes);
    });
  }

  private async reconcileAdPrewarning(schedule: AdsSchedule, grantedScopes?: readonly string[]): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    const scheduler: AdPrewarningScheduler = {
      schedule: (dueAtMs) => this.scheduleAdPrewarning(dueAtMs),
      clear: () => this.clearAdPrewarning(),
    };
    try {
      await refreshAdPrewarningAlarm(this.env, channelId, schedule, broadcasterHasScope, scheduler, grantedScopes);
      await this.ctx.storage.put(AD_PREWARNING_RECONCILED_KEY, {
        schedule: JSON.stringify(schedule),
        scopes: grantedScopes === undefined ? null : [...grantedScopes].sort((a, b) => a.localeCompare(b)).join("\u001f"),
        reconciledAt: Date.now(),
      });
    } catch (error: unknown) {
      await this.ctx.storage.delete(AD_PREWARNING_RECONCILED_KEY);
      console.warn("Ad prewarning alarm reconciliation failed.", error);
    }
  }

  public async getCachedAdSchedule(): Promise<CachedAdSchedule | null> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null) return null;
    const cache = await this.ctx.storage.get<CachedAdSchedule>(AD_SCHEDULE_CACHE_KEY);
    return cache ?? null;
  }

  /** Shares overlay stream lookups across bootstraps for this channel. */
  public async getOverlayStreamDetails(
    expectedStartedAt: string | null,
    expectedStreamId: string | null,
    now: number,
  ): Promise<OverlayStreamDetailsCache | null> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null) return null;
    const cached = await this.ctx.storage.get<CachedOverlayStreamDetails>(OVERLAY_STREAM_DETAILS_CACHE_KEY);
    if (cached !== undefined && cached.expectedStartedAt === expectedStartedAt &&
        cached.expectedStreamId === expectedStreamId &&
        Number.isFinite(cached.checkedAt) && cached.checkedAt <= now &&
        now - cached.checkedAt < OVERLAY_STREAM_DETAILS_CACHE_TTL_MS) {
      return { details: cached.details, expiresAt: cached.checkedAt + OVERLAY_STREAM_DETAILS_CACHE_TTL_MS };
    }

    const cacheIdentity = JSON.stringify([expectedStartedAt, expectedStreamId]);
    const refreshes = this.overlayStreamDetailsRefreshes;
    let refresh = refreshes.get(cacheIdentity);
    if (refresh === undefined) {
      refresh = (async () => {
        let details: OverlayStreamDetails | null = null;
        try {
          const accessToken = await getAppAccessToken(this.env, new Date(now).toISOString());
          const result = await helixRequest<{ data?: unknown }>({
            url: "https://api.twitch.tv/helix/streams",
            query: { user_id: channelId, type: "live" },
            accessToken,
            clientId: this.env.TWITCH_CLIENT_ID,
          });
          if (result.ok && isRecord(result.data) && Array.isArray(result.data.data)) {
            const item: unknown = result.data.data[0];
            if (item === undefined) {
              details = { startedAt: expectedStartedAt, viewerCount: 0 };
            } else if (isRecord(item)) {
              details = {
                startedAt: typeof item.started_at === "string" ? item.started_at : expectedStartedAt,
                viewerCount: typeof item.viewer_count === "number" && Number.isSafeInteger(item.viewer_count)
                  ? item.viewer_count
                  : 0,
              };
            }
          }
        } catch {
          // Cache the miss briefly too, so an API outage cannot multiply lookups per bootstrap.
        }
        await this.ctx.storage.put(OVERLAY_STREAM_DETAILS_CACHE_KEY, {
          expectedStartedAt,
          expectedStreamId,
          checkedAt: now,
          details,
        } satisfies CachedOverlayStreamDetails);
        return { details, expiresAt: now + OVERLAY_STREAM_DETAILS_CACHE_TTL_MS };
      })();
      refreshes.set(cacheIdentity, refresh);
    }
    try {
      return await refresh;
    } finally {
      if (refreshes.get(cacheIdentity) === refresh) refreshes.delete(cacheIdentity);
    }
  }

  /**
   * Shares the channel's current game across chat modules (FAQ and text
   * commands game filters) so a busy chat cannot turn every message into a
   * Helix channel lookup. Reuses the overlay stream-details TTL: game
   * changes are not time-critical enough to warrant their own constant.
   */
  public async getCachedChannelGameId(now: number): Promise<string | null> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null) return null;
    const cached = await this.ctx.storage.get<CachedChannelGameId>(CHANNEL_GAME_ID_CACHE_KEY);
    const cacheTtlMs = cached?.failed === true ? CHANNEL_GAME_ID_FAILURE_CACHE_TTL_MS : OVERLAY_STREAM_DETAILS_CACHE_TTL_MS;
    if (cached !== undefined && Number.isFinite(cached.checkedAt) && cached.checkedAt <= now &&
        now - cached.checkedAt < cacheTtlMs) {
      return cached.gameId;
    }

    let refresh = this.channelGameIdRefresh;
    if (refresh === null) {
      refresh = (async () => {
        let gameId: string | null = null;
        let failed = false;
        try {
          const accessToken = await getAppAccessToken(this.env, new Date(now).toISOString());
          const result = await helixRequest<{ data?: unknown }>({
            url: "https://api.twitch.tv/helix/channels",
            query: { broadcaster_id: channelId },
            accessToken,
            clientId: this.env.TWITCH_CLIENT_ID,
          });
          if (result.ok && isRecord(result.data) && Array.isArray(result.data.data)) {
            const item: unknown = result.data.data[0];
            if (isRecord(item) && typeof item.game_id === "string" && item.game_id.length > 0) gameId = item.game_id;
          } else if (!result.ok) {
            failed = true;
          }
        } catch {
          failed = true;
          // Cache the failure briefly too, so an API outage cannot multiply lookups per message.
        }
        await this.ctx.storage.put(CHANNEL_GAME_ID_CACHE_KEY, { checkedAt: now, gameId, failed } satisfies CachedChannelGameId);
        return { checkedAt: now, gameId, failed } satisfies CachedChannelGameId;
      })();
      this.channelGameIdRefresh = refresh;
    }
    try {
      return (await refresh).gameId;
    } finally {
      if (this.channelGameIdRefresh === refresh) this.channelGameIdRefresh = null;
    }
  }

  /**
   * Keeps the shared game-id cache in step with a `channel.update` EventSub
   * notification for this channel, using the category id it already carries
   * instead of waiting out the cache TTL (or spending another Helix call).
   */
  public async updateCachedChannelGameId(gameId: string | null, now: number): Promise<void> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    await this.ctx.storage.put(CHANNEL_GAME_ID_CACHE_KEY, { checkedAt: now, gameId, failed: false } satisfies CachedChannelGameId);
  }

  public async getAdScheduleGeneration(): Promise<number> {
    await this.ensurePointRoundRecovery();
    return await this.ctx.storage.get<number>(AD_SCHEDULE_GENERATION_KEY) ?? 0;
  }

  /** Refreshes stale countdown data at most once per minute for this channel. */
  public async refreshAdScheduleForCountdown(): Promise<AdScheduleRefreshResult | null> {
    await this.ensurePointRoundRecovery();
    const now = Date.now();
    const cached = await this.getCachedAdSchedule();
    const cachedAt = cached === null ? Number.NaN : Date.parse(cached.asOf);
    const nextAdAt = cached?.schedule.nextAdAt === null || cached?.schedule.nextAdAt === undefined
      ? null
      : Date.parse(cached.schedule.nextAdAt);
    const durationMs = typeof cached?.schedule.duration === "number" && Number.isFinite(cached.schedule.duration)
      ? cached.schedule.duration * 1_000
      : null;
    const adEnded = nextAdAt !== null && Number.isFinite(nextAdAt)
      && nextAdAt <= now && (durationMs === null || now >= nextAdAt + durationMs);
    const stale = cached === null || !Number.isFinite(cachedAt) || now - cachedAt >= AD_COUNTDOWN_SCHEDULE_TTL_MS || adEnded;
    if (!stale) return null;

    const claimed = await this.ctx.storage.transaction(async (transaction) => {
      const previousAttempt = await transaction.get<number>(AD_COUNTDOWN_REFRESH_ATTEMPT_KEY);
      if (typeof previousAttempt === "number" && now - previousAttempt < AD_COUNTDOWN_SCHEDULE_TTL_MS) return false;
      await transaction.put(AD_COUNTDOWN_REFRESH_ATTEMPT_KEY, now);
      return true;
    });
    return claimed ? this.refreshAdSchedule() : null;
  }

  public async refreshAdSchedule(grantedScopes?: readonly string[]): Promise<AdScheduleRefreshResult> {
    await this.ensurePointRoundRecovery();
    const now = Date.now();
    if (this.adScheduleRefresh !== null && now - this.adScheduleRefreshStartedAt < AD_SCHEDULE_REFRESH_TIMEOUT_MS) {
      return this.adScheduleRefresh;
    }
    const refreshGeneration = ++this.adScheduleRefreshGeneration;
    this.adScheduleRefreshStartedAt = now;
    const task = (async (): Promise<AdScheduleRefreshResult> => {
      const channelId = this.ownChannelId();
      if (channelId === null) return { cache: null, reason: "channel_missing", detail: {}, d1Ms: 0, helixMs: 0, changed: false };
      const snapshot = await this.ctx.storage.transaction(async (transaction) => ({
        cache: await transaction.get<CachedAdSchedule>(AD_SCHEDULE_CACHE_KEY) ?? null,
        generation: await transaction.get<number>(AD_SCHEDULE_GENERATION_KEY) ?? 0,
      }));
      const previous = snapshot.cache;
      const retryAfter = await this.getTwitchRateLimitRetryAfter(now);
      if (retryAfter !== null) {
        return { cache: previous, reason: "rate_limited", detail: { retryAfter }, d1Ms: 0, helixMs: 0, changed: false };
      }
      let d1Ms = 0;
      let helixMs = 0;
      const timedGetAppAccessToken: typeof getAppAccessToken = async (...args) => {
        const startedAt = performance.now();
        try {
          return await getAppAccessToken(...args);
        } finally {
          d1Ms += performance.now() - startedAt;
        }
      };
      const timedHelixRequest: HelixRequest = async <Data>(options: HelixRequestOptions<Data>) => {
        const startedAt = performance.now();
        try {
          return await helixRequest<Data>(options);
        } finally {
          helixMs += performance.now() - startedAt;
        }
      };
      const result = await getAdSchedule(this.env, channelId, new Date().toISOString(), timedGetAppAccessToken, timedHelixRequest, fetch);
      if (!result.fetched || result.schedule === null) {
        if (result.reason === "rate_limited") await this.setTwitchRateLimitRetryAfter(Date.now() + TWITCH_RATE_LIMIT_COOLDOWN_MS);
        return { cache: previous, reason: result.reason, detail: result.detail, d1Ms, helixMs, changed: false };
      }
      if (refreshGeneration !== this.adScheduleRefreshGeneration) {
        return { cache: await this.getCachedAdSchedule(), reason: null, detail: result.detail, d1Ms, helixMs, changed: false };
      }
      const asOf = new Date().toISOString();
      const changed = await this.saveAdSchedule(result.schedule, asOf, grantedScopes, snapshot.generation);
      if (changed === null) {
        return { cache: await this.getCachedAdSchedule(), reason: null, detail: result.detail, d1Ms, helixMs, changed: false };
      }
      return { cache: { schedule: result.schedule, asOf }, reason: null, detail: result.detail, d1Ms, helixMs, changed };
    })();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut: Promise<AdScheduleRefreshResult> = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ cache: null, reason: "timeout", detail: {}, d1Ms: 0, helixMs: 0, changed: false });
      }, AD_SCHEDULE_REFRESH_TIMEOUT_MS);
    });
    this.adScheduleRefresh = Promise.race([task, timedOut]);
    try {
      return await this.adScheduleRefresh;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (refreshGeneration === this.adScheduleRefreshGeneration) {
        this.adScheduleRefresh = null;
        this.adScheduleRefreshStartedAt = 0;
      }
    }
  }

  public async storeAdSchedule(
    schedule: AdsSchedule,
    asOf: string,
    grantedScopes?: readonly string[],
    expectedGeneration?: number,
    reconcileAlarm = true,
  ): Promise<CachedAdSchedule | null> {
    await this.ensurePointRoundRecovery();
    const saved = await this.saveAdSchedule(schedule, asOf, grantedScopes, expectedGeneration, reconcileAlarm);
    if (saved === null) return null;
    await this.ctx.storage.delete(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY);
    return { schedule, asOf };
  }

  public async getTwitchRateLimitRetryAfter(now = Date.now()): Promise<number | null> {
    await this.ensurePointRoundRecovery();
    const retryAfter = await this.ctx.storage.get<number>(TWITCH_RETRY_AFTER_KEY);
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > now
      ? retryAfter
      : null;
  }

  public async setTwitchRateLimitRetryAfter(retryAfter: number): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(TWITCH_RETRY_AFTER_KEY, retryAfter);
      await bumpDurablePanelResources(transaction, ["module:ads:schedule"]);
    });
    await this.notifyCommittedPanelResources();
  }

  private async hasAdCountdownOverlay(channelId: string): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `SELECT 1 AS present
         FROM overlay_elements
        WHERE channel_id = ? AND kind = 'ads.countdown'
        LIMIT 1`,
    ).bind(channelId).all<{ present: number }>();
    return result.results.length > 0;
  }

  private async clearAdCountdownRefresh(clearRetries = true): Promise<void> {
    await this.clearAlarmEntry(AD_COUNTDOWN_REFRESH_DEADLINE_KEY);
    if (clearRetries) await this.ctx.storage.delete(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY);
  }

  private async reconcileAdCountdownRefresh(schedule: AdsSchedule): Promise<void> {
    const refreshAt = adCountdownRefreshAt(schedule);
    if (refreshAt === null) {
      await this.clearAdCountdownRefresh(false);
      return;
    }

    const channelId = this.ownChannelId();
    if (channelId === null) return;
    try {
      if (!await this.hasAdCountdownOverlay(channelId)) {
        await this.clearAdCountdownRefresh();
        return;
      }

      const now = Date.now();
      if (refreshAt > now) await this.ctx.storage.delete(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY);
      await this.scheduleAlarmEntry(
        AD_COUNTDOWN_REFRESH_DEADLINE_KEY,
        AD_COUNTDOWN_REFRESH_HANDLER,
        Math.max(refreshAt, now + AD_COUNTDOWN_REFRESH_BUFFER_MS),
      );
    } catch (error: unknown) {
      console.warn("Ad countdown refresh alarm could not be reconciled.", error);
    }
  }

  private async retryAdCountdownRefresh(): Promise<void> {
    const retryCount = await this.ctx.storage.get<number>(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY) ?? 0;
    const retryDelay = AD_COUNTDOWN_REFRESH_RETRY_DELAYS_MS[retryCount];
    if (retryDelay === undefined || !Number.isInteger(retryCount) || retryCount < 0) {
      await this.clearAdCountdownRefresh();
      return;
    }

    const retryAt = Date.now() + retryDelay;
    await this.ctx.storage.put(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY, retryCount + 1);
    await this.scheduleAlarmEntry(AD_COUNTDOWN_REFRESH_DEADLINE_KEY, AD_COUNTDOWN_REFRESH_HANDLER, retryAt);
  }

  private async refreshCountdownScheduleFromAlarm(): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;

    const existingDeadline = await this.readAlarmDeadline(AD_COUNTDOWN_REFRESH_DEADLINE_KEY);
    if (existingDeadline !== null && existingDeadline > Date.now()) return;

    let hasOverlay: boolean;
    try {
      hasOverlay = await this.hasAdCountdownOverlay(channelId);
    } catch (error: unknown) {
      console.warn("Ad countdown overlay lookup failed during refresh.", error);
      await this.retryAdCountdownRefresh();
      return;
    }
    if (!hasOverlay) {
      await this.clearAdCountdownRefresh();
      return;
    }

    try {
      await this.refreshAdScheduleForCountdown();
      const cache = await this.getCachedAdSchedule();
      const nextRefreshAt = cache === null ? null : adCountdownRefreshAt(cache.schedule);
      if (nextRefreshAt !== null && nextRefreshAt > Date.now()) {
        await this.ctx.storage.delete(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY);
        await this.scheduleAlarmEntry(AD_COUNTDOWN_REFRESH_DEADLINE_KEY, AD_COUNTDOWN_REFRESH_HANDLER, nextRefreshAt);
      } else {
        await this.retryAdCountdownRefresh();
      }
    } catch (error: unknown) {
      console.warn("Ad countdown schedule refresh failed.", error);
      await this.retryAdCountdownRefresh();
    }
  }

  /** A durable short lease coalesces overview-triggered refreshes across Worker isolates. */
  public async beginStreamStateRefresh(now = Date.now()): Promise<string | null> {
    await this.ensurePointRoundRecovery();
    const token = crypto.randomUUID();
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StreamRefreshLease>(STREAM_REFRESH_LEASE_KEY);
      if (current !== undefined && current.expiresAt > now) return null;
      await transaction.put(STREAM_REFRESH_LEASE_KEY, { token, expiresAt: now + STREAM_REFRESH_LEASE_MS } satisfies StreamRefreshLease);
      return token;
    });
  }

  public async endStreamStateRefresh(token: string): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StreamRefreshLease>(STREAM_REFRESH_LEASE_KEY);
      if (current?.token === token) await transaction.delete(STREAM_REFRESH_LEASE_KEY);
    });
  }

  private async mutateAlarmSchedule(
    mutate: (table: AlarmScheduleTable, storage: AlarmStorageAccess) => Promise<void> | void,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const table = await readAlarmScheduleTable(transaction);
      await mutate(table, transaction);
      await transaction.put(ALARM_TABLE_KEY, table);
    });
  }

  private async ensureAlarmScheduleTable(): Promise<AlarmScheduleTable> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const table = await readAlarmScheduleTable(transaction);
      if (Object.keys(table).length === 0) await transaction.delete(ALARM_TABLE_KEY);
      else await transaction.put(ALARM_TABLE_KEY, table);
      return table;
    });
  }

  private async scheduleAlarmEntry(
    key: string,
    handler: string,
    deadline: number,
    suppressedBy?: string,
    ownerRevision?: number,
    streamGeneration?: number | null,
    identity?: ModuleAlarmIdentity,
    planSequence?: number,
  ): Promise<void> {
    if (!Number.isFinite(deadline)) {
      await this.clearAlarmEntry(key, ownerRevision, streamGeneration, identity, planSequence);
      return;
    }
    await this.mutateAlarmSchedule(async (table, storage) => {
      if (!await this.acceptAlarmStreamGeneration(storage, key, streamGeneration)) return;
      if (ownerRevision !== undefined && !await this.acceptAlarmOwnerRevision(storage, key, ownerRevision)) return;
      if (identity !== undefined || planSequence !== undefined) {
        const modulePrefix = "module:";
        const moduleSeparator = key.startsWith(modulePrefix) ? key.indexOf(":", modulePrefix.length) : -1;
        const moduleId = moduleSeparator > modulePrefix.length ? key.slice(modulePrefix.length, moduleSeparator) : null;
        const ownsSerializedLifecycle = moduleId !== null &&
          MODULES.find((module) => module.id === moduleId)?.serializeLifecycleMutations === true;
        if (identity === undefined || (planSequence !== undefined &&
            (!Number.isSafeInteger(planSequence) || planSequence < 0)) ||
            (planSequence === undefined && !ownsSerializedLifecycle) ||
            identity.deadline !== deadline || identity.revision !== ownerRevision ||
            identity.generation !== (streamGeneration ?? null)) return;
        const savedValue = await storage.get(MODULE_ALARM_PLAN_SEQUENCES_KEY);
        const saved = isRecord(savedValue) ? savedValue : {};
        const savedFence = validModuleAlarmPlanFence(saved[key]) ? saved[key] : undefined;
        const current = table[key];
        const entryFence = current?.planSequence === undefined ? undefined : {
          ...(current.identity === undefined ? {} : { identity: current.identity }),
          planSequence: current.planSequence,
        };
        const savedFenceForComparison = savedFence === undefined ? undefined : {
          identity: savedFence.identity,
          planSequence: savedFence.planSequence,
          cleared: savedFence.cleared,
        };
        const fence = entryFence !== undefined && (savedFence === undefined ||
          entryFence.planSequence > savedFence.planSequence) ? entryFence : savedFenceForComparison;
        const reusingCurrentPlan = planSequence === undefined && current !== undefined &&
          current.planSequence !== undefined && current.deadline === deadline && current.handler === handler &&
          current.ownerRevision === ownerRevision && current.streamGeneration ===
            (typeof streamGeneration === "number" ? streamGeneration : undefined) &&
          current.suppressedBy === suppressedBy && sameTimerAlarmIdentity(current.identity, identity);
        // A serialized lifecycle module can omit the sequence: the host allocates
        // one atomically for each new identity and reuses it for an unchanged
        // plan, so reconciliation repairs the platform alarm without shifting
        // its baseline or rewriting the module's schedule.
        const acceptedPlanSequence = planSequence ?? (reusingCurrentPlan
          ? current.planSequence ?? -1
          : Math.max(current?.planSequence ?? -1, savedFence?.planSequence ?? -1) + 1);
        if (!acceptsTimerAlarmSet(fence, identity, acceptedPlanSequence)) return;
        if (reusingCurrentPlan) return;
        const now = Date.now();
        const fences = Object.fromEntries(Object.entries(saved).filter(([, value]) =>
          validModuleAlarmPlanFence(value) && now - value.updatedAt <= MODULE_ALARM_PLAN_SEQUENCE_RETENTION_MS,
        )) as Record<string, ModuleAlarmPlanFenceRecord>;
        fences[key] = { identity, planSequence: acceptedPlanSequence, cleared: false, updatedAt: now };
        table[key] = {
          deadline,
          handler,
          revision: (current?.revision ?? 0) + 1,
          ownerRevision,
          ...(typeof streamGeneration === "number" ? { streamGeneration } : {}),
          identity,
          planSequence: acceptedPlanSequence,
          ...(suppressedBy === undefined ? {} : { suppressedBy }),
        };
        await storage.put(MODULE_ALARM_PLAN_SEQUENCES_KEY, fences);
        if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
          await storage.put(key, deadline);
        }
        return;
      }
      if (isTimerOccurrenceAlarmKey(key)) {
        const savedValue = await storage.get(MODULE_ALARM_PLAN_SEQUENCES_KEY);
        const saved = isRecord(savedValue) ? savedValue : {};
        if (validModuleAlarmPlanFence(saved[key]) || table[key]?.identity !== undefined ||
            table[key]?.planSequence !== undefined) return;
      }
      const current = table[key];
      table[key] = {
        deadline,
        handler,
        revision: (current?.revision ?? 0) + 1,
        ...(ownerRevision === undefined ? {} : { ownerRevision }),
        ...(typeof streamGeneration === "number" ? { streamGeneration } : {}),
        ...(suppressedBy === undefined ? {} : { suppressedBy }),
      };
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.put(key, deadline);
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async acceptAlarmStreamGeneration(
    storage: AlarmStorageAccess,
    key: string,
    streamGeneration: number | null | undefined,
  ): Promise<boolean> {
    // Stream-independent timer schedules still carry owner revisions, so
    // they can replace their own prior alarm without weakening generation
    // checks for interval alarms.
    if (streamGeneration === null) return true;
    const storedValue = await storage.get(MODULE_ALARM_STREAM_GENERATIONS_KEY);
    const stored = isRecord(storedValue) ? storedValue as Record<string, number> : {};
    const current = stored[key];
    if (streamGeneration === undefined) {
      // Older workers cannot replace a timer alarm after a versioned write.
      return !key.startsWith("module:timers:timer:") || current === undefined;
    }
    if (!Number.isSafeInteger(streamGeneration) || streamGeneration < 0 ||
        (current !== undefined && Number.isSafeInteger(current) && streamGeneration < current)) {
      return false;
    }
    stored[key] = streamGeneration;
    await storage.put(MODULE_ALARM_STREAM_GENERATIONS_KEY, stored);
    return true;
  }

  private async acceptAlarmOwnerRevision(
    storage: AlarmStorageAccess,
    key: string,
    ownerRevision: number,
  ): Promise<boolean> {
    const now = Date.now();
    const storedValue = await storage.get(MODULE_ALARM_OWNER_REVISIONS_KEY);
    const stored = isRecord(storedValue) ? storedValue as Record<string, { revision: number; updatedAt: number }> : {};
    const current = stored[key];
    if (current !== undefined && Number.isSafeInteger(current.revision) && ownerRevision < current.revision) return false;
    const revisions = Object.fromEntries(Object.entries(stored).filter(([, entry]) =>
      Number.isSafeInteger(entry.revision) && Number.isFinite(entry.updatedAt) && now - entry.updatedAt <= MODULE_ALARM_OWNER_REVISION_RETENTION_MS,
    ));
    revisions[key] = { revision: ownerRevision, updatedAt: now };
    await storage.put(MODULE_ALARM_OWNER_REVISIONS_KEY, revisions);
    return true;
  }

  private async clearAlarmEntry(
    key: string,
    ownerRevision?: number,
    streamGeneration?: number | null,
    expectedIdentity?: ModuleAlarmIdentity | null,
    planSequence?: number,
  ): Promise<void> {
    await this.mutateAlarmSchedule(async (table, storage) => {
      if (!await this.acceptAlarmStreamGeneration(storage, key, streamGeneration)) return;
      if (ownerRevision !== undefined && !await this.acceptAlarmOwnerRevision(storage, key, ownerRevision)) return;
      if (planSequence !== undefined) {
        if (!Number.isSafeInteger(planSequence) || planSequence < 0) return;
        const savedValue = await storage.get(MODULE_ALARM_PLAN_SEQUENCES_KEY);
        const saved = isRecord(savedValue) ? savedValue : {};
        const savedFence = validModuleAlarmPlanFence(saved[key]) ? saved[key] : undefined;
        const current = table[key];
        const entryFence = current?.planSequence === undefined ? undefined : {
          ...(current.identity === undefined ? {} : { identity: current.identity }),
          planSequence: current.planSequence,
        };
        const savedFenceForComparison = savedFence === undefined ? undefined : {
          identity: savedFence.identity,
          planSequence: savedFence.planSequence,
          cleared: savedFence.cleared,
        };
        const fence = entryFence !== undefined && (savedFence === undefined ||
          entryFence.planSequence > savedFence.planSequence) ? entryFence : savedFenceForComparison;
        if (!acceptsTimerAlarmClear(fence, expectedIdentity, planSequence)) return;
        const now = Date.now();
        const fences = Object.fromEntries(Object.entries(saved).filter(([, value]) =>
          validModuleAlarmPlanFence(value) && now - value.updatedAt <= MODULE_ALARM_PLAN_SEQUENCE_RETENTION_MS,
        )) as Record<string, ModuleAlarmPlanFenceRecord>;
        Reflect.deleteProperty(table, key);
        fences[key] = {
          identity: expectedIdentity ?? null,
          planSequence,
          cleared: true,
          updatedAt: now,
        };
        await storage.put(MODULE_ALARM_PLAN_SEQUENCES_KEY, fences);
        if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
          await storage.delete(key);
        }
        return;
      }
      if (isTimerOccurrenceAlarmKey(key)) {
        const savedValue = await storage.get(MODULE_ALARM_PLAN_SEQUENCES_KEY);
        const saved = isRecord(savedValue) ? savedValue : {};
        if (validModuleAlarmPlanFence(saved[key]) || table[key]?.identity !== undefined ||
            table[key]?.planSequence !== undefined) return;
      }
      Reflect.deleteProperty(table, key);
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.delete(key);
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async clearAlarmEntries(keys: readonly string[]): Promise<void> {
    await this.mutateAlarmSchedule(async (table, storage) => {
      for (const key of keys) {
        Reflect.deleteProperty(table, key);
        if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
          await storage.delete(key);
        }
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async readAlarmDeadline(key: string): Promise<number | null> {
    const table = await this.ensureAlarmScheduleTable();
    const entry = table[key];
    return entry === undefined ? null : entry.deadline;
  }

  private async claimAlarmEntry(
    key: string,
    expected: AlarmScheduleEntry,
  ): Promise<AlarmScheduleEntry | null> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const table = await readAlarmScheduleTable(transaction);
      const current = table[key];
      const now = Date.now();
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(expected) || alarmAttemptAt(current) > now) {
        await transaction.put(ALARM_TABLE_KEY, table);
        return null;
      }
      const claimed: AlarmScheduleEntry = {
        ...current,
        claimUntil: now + ALARM_HANDLER_RECOVERY_DELAY_MS,
        revision: (current.revision ?? 0) + 1,
      };
      delete claimed.nextAttemptAt;
      table[key] = claimed;
      await transaction.put(ALARM_TABLE_KEY, table);
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await transaction.put(key, claimed.claimUntil);
      }
      return claimed;
    });
  }

  private async completeAlarmEntry(key: string, claimed: AlarmScheduleEntry): Promise<void> {
    await this.mutateAlarmSchedule(async (table, storage) => {
      if (JSON.stringify(table[key]) !== JSON.stringify(claimed)) return;
      Reflect.deleteProperty(table, key);
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.delete(key);
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async retainAlarmEntry(key: string, claimed: AlarmScheduleEntry): Promise<void> {
    await this.mutateAlarmSchedule(async (table, storage) => {
      if (JSON.stringify(table[key]) !== JSON.stringify(claimed)) return;
      const entry = { ...claimed };
      delete entry.claimUntil;
      delete entry.nextAttemptAt;
      const retained: AlarmScheduleEntry = {
        ...entry,
        nextAttemptAt: Date.now() + ALARM_HANDLER_RECOVERY_DELAY_MS,
        revision: (claimed.revision ?? 0) + 1,
      };
      table[key] = retained;
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.put(key, alarmAttemptAt(retained));
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async rescheduleFailedAlarm(
    key: string,
    claimed: AlarmScheduleEntry,
    retryDelaysMs: readonly number[] | undefined,
  ): Promise<void> {
    const configuredDelays = retryDelaysMs?.filter((delay) => Number.isFinite(delay) && delay >= 1);
    const delays = configuredDelays?.length ? configuredDelays : ALARM_HANDLER_RETRY_DELAYS_MS;
    const failures = claimed.failures ?? 0;
    const delay = delays[Math.min(failures, delays.length - 1)];
    if (delay === undefined || !Number.isFinite(delay) || delay < 1) return;
    await this.mutateAlarmSchedule(async (table, storage) => {
      const current = table[key];
      if (JSON.stringify(current) !== JSON.stringify(claimed)) return;
      const entry = { ...claimed };
      delete entry.claimUntil;
      delete entry.nextAttemptAt;
      table[key] = {
        ...entry,
        nextAttemptAt: Date.now() + delay,
        failures: failures + 1,
        revision: (claimed.revision ?? 0) + 1,
      };
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.put(key, alarmAttemptAt(table[key]));
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private moduleAlarmContext(
    moduleId: string,
    registration: ModuleAlarmDefinition,
    externalFetchBudget: ModuleExternalFetchBudget,
    streamGeneration?: number,
    alarmIdentity?: ModuleAlarmIdentity,
    alarmPlanSequence?: number,
    sendChatImpl: typeof sendChatMessage = sendChatMessage,
  ): ModuleAlarmContext {
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Module alarms require a named Durable Object.");
    const storagePrefix = `module:${moduleId}:storage:`;
    const handler = `module:${moduleId}:${registration.key}`;
    const context: ModuleAlarmContext = {
      DB: this.env.DB,
      channelId,
      writeModuleAudit: (entry, changedAt, options) => writeModuleAudit(
        this.env.DB, options?.actorUserId ?? "system", changedAt,
        { ...entry, channelId, moduleId }, options?.actorUserId === undefined ? "system" : "member", options,
      ),
      alarmIdentity: alarmIdentity ?? null,
      ...(alarmPlanSequence === undefined ? {} : { alarmPlanSequence }),
      ...(streamGeneration === undefined ? {} : { streamGeneration }),
      externalFetchBudget,
      statisticsChat: {
        advanceToBoundary: (boundary, streamIsOnline, streamId) =>
          this.advanceStatisticsToBoundary(boundary, streamIsOnline, streamId),
        listDirtyCompletedWindows: () => this.listDirtyCompletedStatisticsWindows(),
        readWindow: (windowStart) => this.readStatisticsWindow(windowStart),
        saveWindowMetrics: (windowStart, viewerCount, chatters) =>
          this.saveStatisticsWindowMetrics(windowStart, viewerCount, chatters),
        markWindowClean: (windowStart, revision) => this.markStatisticsWindowClean(windowStart, revision),
        pruneExpiredWindows: (now) => this.pruneExpiredStatisticsWindows(now),
        hasWindows: () => this.hasStatisticsWindows(),
        flushWordCounts: () => this.flushStatisticsWordCounts(),
        markWordStreamEnded: (streamId, endedAt) => this.markStatisticsWordStreamEnded(streamId, endedAt),
        reconcileWordStreams: (streamIsOnline, streamId, observedAt) =>
          this.reconcileStatisticsWordStreams(streamIsOnline, streamId, observedAt),
        listMergeableWordBuckets: (streamIsOnline, streamId, idleBefore) =>
          this.listMergeableStatisticsWordBuckets(streamIsOnline, streamId, idleBefore),
        prepareWordBucketForMerge: (bucket, streamIsOnline, streamId, idleBefore) =>
          this.prepareStatisticsWordBucketForMerge(bucket, streamIsOnline, streamId, idleBefore),
        deleteWordBucket: (bucket) => this.deleteStatisticsWordBucket(bucket),
        pruneExpiredWordStreams: (now) => this.pruneExpiredStatisticsWordStreams(now),
        hasWordStreams: () => this.hasStatisticsWordStreams(),
        markClipImportPending: (streamId, startedAt, endedAt) =>
          this.markStatisticsClipImportPending(streamId, startedAt, endedAt),
        listReadyClipImports: (now) => this.listReadyStatisticsClipImports(now),
        completeClipImport: (streamId, endedAt) => this.completeStatisticsClipImport(streamId, endedAt),
        pruneExpiredClipImports: (now) => this.pruneExpiredStatisticsClipImports(now),
        hasClipImports: () => this.hasStatisticsClipImports(),
      },
      recordTimelineEvent: (event: ModuleTimelineEvent) =>
        writeChannelTimelineEvent(this.env.DB, channelId, event),
      recordTimelineEventStrict: (event: ModuleTimelineEvent) =>
        writeChannelTimelineEventOrThrow(this.env.DB, channelId, event),
      fetchViewerCount: () => fetchLiveViewerCount(this.env, channelId, externalFetchBudget),
      fetchChattersTotal: () => fetchLiveChattersTotal(this.env, channelId, externalFetchBudget),
      fetchStreamClips: (startedAt, endedAt) => fetchTwitchStreamClips(
        this.env,
        channelId,
        startedAt,
        endedAt,
        externalFetchBudget,
      ),
      ballots: this.ballotAccess(moduleId),
      points: this.pointAccess(moduleId),
      secrets: createModuleSecretAccess(this.env, channelId, moduleId),
      channelLanguage: async () => {
        const row = await this.env.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
          .bind(channelId).first<{ language: string }>();
        return row?.language === "en" ? "en" : "de";
      },
      secureRandomInteger,
      executeTimeout: async (action) => {
        const module = MODULES.find((candidate) => candidate.id === moduleId);
        if (!await moduleEnabledForChannel(this.env.DB, channelId, moduleId, module?.mandatory === true)) {
          return "suppressed";
        }
        return (await sendModerationBan(this.env, channelId, {
          userId: action.userId,
          durationSeconds: action.durationSeconds,
          reason: action.reason,
        })).outcome;
      },
      storage: {
        get: (key: string) => this.ctx.storage.get(`${storagePrefix}${key}`),
        put: async (key: string, value: unknown) => {
          await this.ctx.storage.transaction(async (transaction) => {
            await transaction.put(`${storagePrefix}${key}`, value);
            await bumpDurablePanelResources(transaction, [`module:${moduleId}:data`]);
          });
          await this.notifyCommittedPanelResources();
        },
        delete: async (key: string) => {
          const deleted = await this.ctx.storage.transaction(async (transaction) => {
            const removed = await transaction.delete(`${storagePrefix}${key}`);
            if (removed) await bumpDurablePanelResources(transaction, [`module:${moduleId}:data`]);
            return removed;
          });
          if (deleted) await this.notifyCommittedPanelResources();
          return deleted;
        },
        list: async (prefix: string, limit: number, startAfter?: string) => {
          if (!Number.isSafeInteger(limit) || limit < 1) return new Map<string, unknown>();
          const entries = await this.ctx.storage.list({
            prefix: `${storagePrefix}${prefix}`,
            limit,
            ...(startAfter === undefined ? {} : { startAfter: `${storagePrefix}${startAfter}` }),
          });
          return new Map([...entries].map(([key, value]) => [key.slice(storagePrefix.length), value]));
        },
      },
      schedule: async (key, deadline, ownerRevision, scheduledStreamGeneration, identity, planSequence) => {
        const scheduledRegistration = MODULES.find((module) => module.id === moduleId)?.alarms?.find((alarm) => alarm.key === key);
        await this.scheduleAlarmEntry(
          `module:${moduleId}:${key}`,
          scheduledRegistration === undefined ? handler : `module:${moduleId}:${scheduledRegistration.key}`,
          deadline,
          undefined,
          ownerRevision,
          scheduledStreamGeneration,
          identity,
          planSequence,
        );
      },
      clear: async (key, ownerRevision, scheduledStreamGeneration, expectedIdentity, planSequence) => {
        await this.clearAlarmEntry(`module:${moduleId}:${key}`, ownerRevision, scheduledStreamGeneration,
          expectedIdentity, planSequence);
      },
      getAlarmDeadline: (key) => this.getModuleAlarmDeadline(moduleId, key),
      getAlarmPlan: (key) => this.getModuleAlarmPlan(moduleId, key),
      renderTemplate: async (text, moduleValuesOrNow = {}, nowOrModuleValues = Date.now()) => {
        const now = typeof moduleValuesOrNow === "number"
          ? moduleValuesOrNow
          : typeof nowOrModuleValues === "number" ? nowOrModuleValues : Date.now();
        const moduleValues = typeof moduleValuesOrNow === "number"
          ? typeof nowOrModuleValues === "object" ? nowOrModuleValues : {}
          : moduleValuesOrNow;
        return renderScheduledTemplate(
          this.env,
          channelId,
          text,
          now,
          externalFetchBudget,
          moduleValues,
          (runModuleId, handlerKey, alarmKey, invocation) => invocation === undefined
            ? this.runModuleAlarm(runModuleId, handlerKey, alarmKey)
            : this.runModuleAlarm(runModuleId, handlerKey, alarmKey, invocation),
        );
      },
      publishModuleOverlayMessage: async (type, elementKind, payload) => {
        const prepared = await prepareModuleOverlayRealtimeMessage(this.env.DB, channelId, moduleId, {
          kind: "overlay",
          type,
          elementKind,
          payload,
        });
        if (prepared.outcome === "ready") await this.publish([prepared.message]);
      },
      sendChat: async (text, idempotencyKey, attributions = [], stillValid, target, options) => {
        const suppression = { reason: null as string | null };
        const validateOutput = async (): Promise<boolean> => {
          if (stillValid !== undefined && !await stillValid()) {
            suppression.reason = "stale_before_send";
            return false;
          }
          const [channelState, registration] = await Promise.all([
            readDispatchChannelState(this.env.DB, channelId, new Date().toISOString()),
            Promise.resolve(MODULES.find((module) => module.id === moduleId)),
          ]);
          const activation = channelState.activations.find((entry) => entry.moduleId === moduleId);
          suppression.reason = chatOutputSuppressionReason({
            moduleEnabled: registration?.mandatory === true || activation?.enabled === true,
            mandatory: registration?.mandatory === true,
            paused: channelState.controls.pause.active,
            muted: channelState.controls.mute.active,
          });
          if (suppression.reason !== null) return false;
          if (stillValid !== undefined && !await stillValid()) {
            suppression.reason = "stale_before_send";
            return false;
          }
          return true;
        };
        const claimBeforePost = async (): Promise<boolean | "rate_limited"> => {
          if (!await validateOutput()) return false;
          return await claimModuleAlarmSend(this.ctx.storage, idempotencyKey, Date.now(),
            /^round:[^:]+:resolve$/u.test(idempotencyKey) ? POINTS_ANNOUNCE_AMBIGUOUS_MS : undefined,
            { automated: options?.automated !== false });
        };
        const afterPost = async (delivery: "sent" | "rejected" | "ambiguous" | "not_attempted"): Promise<void> => {
          if (delivery !== "not_attempted") await finishModuleAlarmSend(this.ctx.storage, idempotencyKey, delivery, Date.now());
        };
        const result = await sendChatImpl(
          this.env,
          channelId,
          text,
          options?.replyToMessageId,
          fetch,
          validateOutput,
          claimBeforePost,
          attributions,
          afterPost,
          target ?? await readChannelDefaultChatTarget(this.env.DB, channelId),
          options?.sourceBroadcasterUserId,
          (senderId, messageText) => this.recordBotChatMessage(senderId, messageText),
        );
        let attemptedAt: number | undefined;
        let hasPersistedSendClaim = false;
        if (result.reason === "already_attempted") {
          const claim = await readModuleAlarmSendClaim(this.ctx.storage, idempotencyKey);
          if (claim?.status === "sent") return { sent: true, reason: null, retryable: false, delivery: "delivered" };
          hasPersistedSendClaim = claim !== null;
          attemptedAt = claim?.at;
        }
        const reason = suppression.reason ?? result.reason;
        const retryable = suppression.reason === null && result.reason !== "stale_before_send" &&
          result.reason !== "already_attempted" && result.delivery !== "ambiguous";
        const ambiguous = result.reason === "already_attempted"
          ? hasPersistedSendClaim
          : result.delivery === "ambiguous";
        const delivery = result.sent
          ? "delivered"
          : result.reason === "rate_limited" ? "rate_limited"
            : ambiguous ? "ambiguous"
              : result.delivery === "not_attempted" ? "not_attempted"
                : "failed";
        return { sent: result.sent, reason, retryable, delivery, ...(attemptedAt === undefined ? {} : { attemptedAt }) };
      },
      chatActivityCount: () => this.getChatActivityCount(),
      resolveEventTimes: (now) => resolveModuleEventTimes(this.env.DB, channelId, now),
      streamState: async () => (await readChannelStreamState(this.env.DB, channelId))?.state ?? "unknown",
      streamStartedAt: async () => {
        const state = await readChannelStreamState(this.env.DB, channelId);
        return state === null ? { streamId: null, startedAt: null } : { streamId: state.streamId, startedAt: state.startedAt };
      },
      writeDiagnostics: (triggerId, diagnostics, now) =>
        writeModuleDiagnostics(this.env.DB, channelId, moduleId, triggerId, null, diagnostics, now),
    };
    if (moduleId === "timers") {
      context.runTimerOccurrence = (key, deadline, ownerRevision, identity, planSequence, alarmContext) =>
        this.runTimerOccurrence(alarmContext ?? context, key, deadline, ownerRevision, identity, planSequence);
      context.reconcileTimerSchedules = (reason) => this.reconcileTimerSchedules(reason);
    }
    return context;
  }

  /** Counts accepted chat in either stream state; timer baselines separate each interval state. */
  public async recordChatActivity(
    chatterUserId: string | null = null,
    needsActiveChatters = false,
    statistics?: StatisticsChatActivity,
  ): Promise<number> {
    await this.ensurePointRoundRecovery();
    await this.ensureTimerSchedulesInitialized();
    this.reconcileLegacyActiveChatterStream();
    const statisticsReceivedAt = statistics === undefined ? Number.NaN : Date.parse(statistics.receivedAt);
    const now = Number.isFinite(statisticsReceivedAt) ? statisticsReceivedAt : Date.now();
    const nowIso = new Date(now).toISOString();
    const userIdForTracking = needsActiveChatters && typeof chatterUserId === "string" && chatterUserId.length > 0
      ? chatterUserId
      : null;
    const statisticsWindowStart = statistics === undefined ? Number.NaN : Date.parse(statistics.windowStart);
    const statisticsEmotesValid = statistics !== undefined && Number.isSafeInteger(statistics.emotes) && statistics.emotes >= 0;
    const recordStatistics = (): void => {
      if (statistics === undefined) return;
      if (!Number.isFinite(statisticsWindowStart) || !statisticsEmotesValid) return;
      this.ensureStatisticsSchema();
      this.ensureStatisticsWindowSync(statisticsWindowStart, statistics.streamId);
      this.ctx.storage.sql.exec(
        `INSERT INTO ${STATISTICS_CHAT_WINDOW_TABLE}
          (window_start, stream_id, messages, emotes, revision, dirty)
         VALUES (?, ?, 1, ?, 1, 1)
         ON CONFLICT(window_start) DO UPDATE SET
           stream_id = COALESCE(statistics_chat_windows.stream_id, excluded.stream_id),
           messages = statistics_chat_windows.messages + 1,
           emotes = statistics_chat_windows.emotes + excluded.emotes,
           revision = statistics_chat_windows.revision + 1,
           dirty = 1`,
        statisticsWindowStart,
        statistics.streamId,
        statistics.emotes,
      );
      this.recordStatisticsWordCountsSync(statistics.streamId, statistics.textFragments ?? [], statistics.receivedAt);
    };
    if (userIdForTracking === null) {
      const activityCount = this.ctx.storage.transactionSync(() => {
        recordStatistics();
        return this.incrementChatActivityCountSync();
      });
      if (statistics !== undefined && Number.isFinite(statisticsWindowStart) && statisticsEmotesValid) {
        await this.ensureStatisticsWindowAlarmScheduled(now);
      }
      return activityCount;
    }

    const activityCount = await this.ctx.blockConcurrencyWhile(async () => {
      this.ensureActiveChatterTable();
      if (statistics !== undefined && Number.isFinite(statisticsWindowStart) && statisticsEmotesValid) {
        this.ensureStatisticsSchema();
      }
      const current = this.activeChatterKeyRowSync();
      const rotating = current === null || now - current.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS;
      const keyHex = rotating
        ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
        : current.keyHex;
      const keyCreatedAt = rotating ? now : current.createdAt;
      const hmac = await activeChatterKey(keyHex, this.ownChannelId() ?? "", userIdForTracking);
      const currentSweep = rotating ? null : this.activeChatterNextSweepSync(keyCreatedAt);
      const preflightDeadline = Math.min(
        currentSweep ?? Number.POSITIVE_INFINITY,
        now + ACTIVE_CHATTER_RETENTION_MS,
        keyCreatedAt + ACTIVE_CHATTER_KEY_ROTATION_MS,
      );

      try {
        await this.ensurePlatformActiveChatterAlarm(preflightDeadline);
      } catch (error: unknown) {
        this.ctx.storage.transactionSync(() => {
          recordStatistics();
          this.incrementChatActivityCountSync();
        });
        if (statistics !== undefined && Number.isFinite(statisticsWindowStart) && statisticsEmotesValid) {
          await this.ensureStatisticsWindowAlarmScheduled(now);
        }
        throw error;
      }
      return this.ctx.storage.transactionSync(() => {
        this.ensureActiveChatterTable();
        const latest = this.activeChatterKeyRowSync();
        const latestRotating = latest === null || now - latest.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS;
        if (latestRotating || latest.keyHex !== keyHex || latest.createdAt !== keyCreatedAt) {
          this.clearActiveChatterRecordsSync();
          this.ctx.storage.sql.exec(`DELETE FROM ${ACTIVE_CHATTER_KEY_TABLE}`);
          this.ctx.storage.kv.delete(LEGACY_ACTIVE_CHATTER_STREAM_KEY);
          this.ctx.storage.sql.exec(
            `INSERT INTO ${ACTIVE_CHATTER_KEY_TABLE} (slot, key_hex, created_at) VALUES (1, ?, ?)`,
            keyHex,
            new Date(keyCreatedAt).toISOString(),
          );
        }
        this.recordActiveChatter(hmac, nowIso);
        const nextSweep = this.activeChatterNextSweepSync(keyCreatedAt);
        if (nextSweep === null) this.clearActiveChatterExpiryEntrySync();
        else this.writeActiveChatterExpiryEntrySync(nextSweep);
        recordStatistics();
        return this.incrementChatActivityCountSync();
      });
    });
    if (statistics !== undefined && Number.isFinite(statisticsWindowStart) && statisticsEmotesValid) {
      await this.ensureStatisticsWindowAlarmScheduled(now);
    }
    return activityCount;
  }

  private pruneExpiredStatisticsWordStreamsSync(now: number): void {
    const expiredIds = new Set(this.ctx.storage.sql.exec<{ stream_id: string }>(
      `SELECT stream_id FROM ${STATISTICS_WORD_STREAM_TABLE} WHERE expires_at <= ?`,
      now,
    ).toArray().map(({ stream_id: streamId }) => streamId));
    for (const [streamId, endedAt] of this.statisticsWordStreamEndedAt) {
      if (endedAt + STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS <= now) expiredIds.add(streamId);
    }
    this.ctx.storage.sql.exec(
      `DELETE FROM ${STATISTICS_WORD_COUNT_TABLE}
        WHERE stream_id IN (
          SELECT stream_id FROM ${STATISTICS_WORD_STREAM_TABLE} WHERE expires_at <= ?
        )`,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM ${STATISTICS_WORD_SEEN_TABLE}
        WHERE stream_id IN (
          SELECT stream_id FROM ${STATISTICS_WORD_STREAM_TABLE} WHERE expires_at <= ?
        )`,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM ${STATISTICS_WORD_STREAM_TABLE} WHERE expires_at <= ?`,
      now,
    );
    for (const [key, count] of this.statisticsWordCounts) {
      if (expiredIds.has(count.streamId)) this.statisticsWordCounts.delete(key);
    }
    for (const streamId of expiredIds) {
      this.statisticsWordWordsByStream.delete(streamId);
      this.statisticsWordNewDistinctByStream.delete(streamId);
      this.statisticsWordLastBufferedIncrementAt.delete(streamId);
      this.statisticsWordStreamEndedAt.delete(streamId);
    }
  }

  private recordStatisticsWordCountsSync(
    streamId: string | null,
    textFragments: readonly string[],
    receivedAt: string,
  ): void {
    if (streamId === null || streamId.length === 0 || textFragments.length === 0) return;
    const counts = tokenizeStatisticsWords(textFragments);
    if (counts.size === 0) return;

    const now = Date.now();
    const receivedAtMs = Date.parse(receivedAt);
    const lastSeenAt = Number.isFinite(receivedAtMs) ? new Date(receivedAtMs).toISOString() : new Date(now).toISOString();
    this.ensureStatisticsSchema();
    const stream = this.ctx.storage.sql.exec<{
      distinct_words: number;
      expires_at: number;
    }>(
      `SELECT distinct_words, expires_at FROM ${STATISTICS_WORD_STREAM_TABLE} WHERE stream_id = ?`,
      streamId,
    ).toArray()[0];
    const memoryEndedAt = this.statisticsWordStreamEndedAt.get(streamId);
    if (stream !== undefined && stream.expires_at <= now ||
        stream === undefined && memoryEndedAt !== undefined &&
          memoryEndedAt + STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS <= now) return;
    const bufferedWords = this.statisticsWordWordsByStream.get(streamId) ?? new Set<string>();
    // Only this message's (at most 20) words are looked up; the stream-wide buffer is never copied.
    const existingWords = new Set<string>();
    const candidates: string[] = [];
    for (const word of counts.keys()) {
      if (bufferedWords.has(word)) existingWords.add(word);
      else candidates.push(word);
    }
    if (candidates.length > 0) {
      const placeholders = candidates.map(() => "?").join(", ");
      const rows = this.ctx.storage.sql.exec<{ word: string }>(
        `SELECT word FROM ${STATISTICS_WORD_SEEN_TABLE}
          WHERE stream_id = ? AND word IN (${placeholders})`,
        streamId,
        ...candidates,
      ).toArray();
      for (const row of rows) existingWords.add(row.word);
    }

    const bufferedDistinct = this.statisticsWordNewDistinctByStream.get(streamId) ?? 0;
    const { accepted, addedDistinctWords } = admitStatisticsWordCounts(
      counts,
      existingWords,
      (stream?.distinct_words ?? 0) + bufferedDistinct,
    );
    for (const [word, count] of accepted) {
      const key = `${streamId}\u0000${word}`;
      const buffered = this.statisticsWordCounts.get(key);
      if (buffered !== undefined) {
        buffered.count += count;
        buffered.lastSeenAt = buffered.lastSeenAt < lastSeenAt ? lastSeenAt : buffered.lastSeenAt;
        buffered.lastIncrementAt = now;
      } else {
        this.statisticsWordCounts.set(key, { streamId, word, count, lastSeenAt, lastIncrementAt: now });
      }
      bufferedWords.add(word);
    }
    if (accepted.size > 0) this.statisticsWordLastBufferedIncrementAt.set(streamId, now);
    if (bufferedWords.size > 0) this.statisticsWordWordsByStream.set(streamId, bufferedWords);
    if (addedDistinctWords > 0) {
      this.statisticsWordNewDistinctByStream.set(streamId, bufferedDistinct + addedDistinctWords);
    }
  }

  private flushStatisticsWordCounts(): Promise<void> {
    if (this.statisticsWordCounts.size === 0) return Promise.resolve();
    this.ensureStatisticsSchema();
    const countsByStream = new Map<string, BufferedStatisticsWordCount[]>();
    for (const count of this.statisticsWordCounts.values()) {
      const stream = countsByStream.get(count.streamId) ?? [];
      stream.push(count);
      countsByStream.set(count.streamId, stream);
    }

    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      for (const [streamId, counts] of countsByStream) {
        const endedAt = this.statisticsWordStreamEndedAt.get(streamId) ?? null;
        const expiresAt = endedAt === null
          ? now + STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS
          : endedAt + STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS;
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO ${STATISTICS_WORD_STREAM_TABLE}
             (stream_id, distinct_words, ended_at, expires_at, current_batch)
           VALUES (?, 0, ?, ?, 1)`,
          streamId,
          endedAt,
          expiresAt,
        );
        if (endedAt === null) {
          this.ctx.storage.sql.exec(
            `UPDATE ${STATISTICS_WORD_STREAM_TABLE} SET expires_at = MAX(expires_at, ?)
              WHERE stream_id = ? AND ended_at IS NULL`,
            expiresAt,
            streamId,
          );
        } else {
          this.ctx.storage.sql.exec(
            `UPDATE ${STATISTICS_WORD_STREAM_TABLE}
                SET ended_at = ?, expires_at = ?
              WHERE stream_id = ? AND ended_at IS NULL`,
            endedAt,
            expiresAt,
            streamId,
          );
        }
        const currentBatch = this.ctx.storage.sql.exec<{ current_batch: number }>(
          `SELECT current_batch FROM ${STATISTICS_WORD_STREAM_TABLE} WHERE stream_id = ?`,
          streamId,
        ).one().current_batch;
        for (let offset = 0; offset < counts.length; offset += 100) {
          const chunk = counts.slice(offset, offset + 100);
          const payload = JSON.stringify(chunk.map(({ word, count, lastSeenAt, lastIncrementAt }) => ({
            word, count, lastSeenAt, lastIncrementAt,
          })));
          this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO ${STATISTICS_WORD_SEEN_TABLE} (stream_id, word)
             SELECT ?, json_extract(value, '$.word') FROM json_each(?)`,
            streamId,
            payload,
          );
          this.ctx.storage.sql.exec(
            `INSERT INTO ${STATISTICS_WORD_COUNT_TABLE}
               (stream_id, batch, word, count, last_seen_at, last_increment_at)
             SELECT ?, ?, json_extract(value, '$.word'), CAST(json_extract(value, '$.count') AS INTEGER),
                    json_extract(value, '$.lastSeenAt'), CAST(json_extract(value, '$.lastIncrementAt') AS INTEGER)
               FROM json_each(?) WHERE 1
             ON CONFLICT (stream_id, batch, word) DO UPDATE SET
               count = ${STATISTICS_WORD_COUNT_TABLE}.count + excluded.count,
               last_seen_at = MAX(${STATISTICS_WORD_COUNT_TABLE}.last_seen_at, excluded.last_seen_at),
               last_increment_at = MAX(${STATISTICS_WORD_COUNT_TABLE}.last_increment_at, excluded.last_increment_at)`,
            streamId,
            currentBatch,
            payload,
          );
        }
        this.ctx.storage.sql.exec(
          `UPDATE ${STATISTICS_WORD_STREAM_TABLE}
              SET distinct_words = (
                SELECT COUNT(*) FROM ${STATISTICS_WORD_SEEN_TABLE} WHERE stream_id = ?
              )
            WHERE stream_id = ?`,
          streamId,
          streamId,
        );
        this.statisticsWordStreamEndedAt.delete(streamId);
      }
    });
    this.statisticsWordCounts.clear();
    this.statisticsWordWordsByStream.clear();
    this.statisticsWordNewDistinctByStream.clear();
    this.statisticsWordLastBufferedIncrementAt.clear();
    return Promise.resolve();
  }

  public advanceStatisticsToBoundary(
    boundary: number,
    streamIsOnline: boolean,
    streamId: string | null,
  ): Promise<void> {
    if (!Number.isSafeInteger(boundary) || boundary % STATISTICS_WINDOW_MILLISECONDS !== 0) return Promise.resolve();
    this.ensureStatisticsSchema();
    this.ctx.storage.transactionSync(() => {
      const completedWindowStart = boundary - STATISTICS_WINDOW_MILLISECONDS;
      if (streamIsOnline) this.ensureStatisticsWindowSync(completedWindowStart, streamId);
      this.ctx.storage.sql.exec(
        `UPDATE ${STATISTICS_CHAT_WINDOW_TABLE}
            SET complete = 1, dirty = 1, revision = revision + 1
          WHERE complete = 0 AND window_start + ? <= ?`,
        STATISTICS_WINDOW_MILLISECONDS,
        boundary,
      );
      if (!streamIsOnline) return;
      const completed = this.ctx.storage.sql.exec<{ active_chatters_sampled: number }>(
        `SELECT active_chatters_sampled FROM ${STATISTICS_CHAT_WINDOW_TABLE} WHERE window_start = ?`,
        completedWindowStart,
      ).toArray()[0];
      if (completed !== undefined && completed.active_chatters_sampled === 0) {
        const activeChatters = this.activeChattersAtBoundarySync(boundary);
        this.ctx.storage.sql.exec(
          `UPDATE ${STATISTICS_CHAT_WINDOW_TABLE}
              SET active_chatters = ?, active_chatters_sampled = 1,
                  dirty = 1, revision = revision + 1
            WHERE window_start = ? AND active_chatters_sampled = 0`,
          activeChatters,
          completedWindowStart,
        );
      }
      this.ensureStatisticsWindowSync(boundary, streamId);
      this.ctx.storage.sql.exec(
        `UPDATE ${STATISTICS_CHAT_WINDOW_TABLE} SET complete = 0 WHERE window_start = ?`,
        boundary,
      );
    });
    return Promise.resolve();
  }

  public listDirtyCompletedStatisticsWindows(): Promise<readonly string[]> {
    this.ensureStatisticsSchema();
    const rows = this.ctx.storage.sql.exec<{ window_start: number }>(
      `SELECT window_start FROM ${STATISTICS_CHAT_WINDOW_TABLE}
        WHERE dirty = 1 AND complete = 1
        ORDER BY window_start ASC`,
    ).toArray();
    return Promise.resolve(rows.map(({ window_start: start }) => new Date(start).toISOString()));
  }

  public readStatisticsWindow(windowStart: string): Promise<ModuleStatisticsWindow | null> {
    const parsed = Date.parse(windowStart);
    if (!Number.isSafeInteger(parsed)) return Promise.resolve(null);
    this.ensureStatisticsSchema();
    const row = this.ctx.storage.sql.exec<{
      stream_id: string | null;
      window_start: number;
      messages: number;
      emotes: number;
      viewer_count: number | null;
      chatters: number | null;
      active_chatters: number | null;
      metrics_sampled: number;
      revision: number;
    }>(
      `SELECT stream_id, window_start, messages, emotes,
              viewer_count, chatters, active_chatters, metrics_sampled, revision
         FROM ${STATISTICS_CHAT_WINDOW_TABLE} WHERE window_start = ?`,
      parsed,
    ).toArray()[0];
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve({
      streamId: row.stream_id,
      windowStart: new Date(row.window_start).toISOString(),
      messages: row.messages,
      emotes: row.emotes,
      viewerCount: row.viewer_count,
      chatters: row.chatters,
      activeChatters: row.active_chatters,
      metricsSampled: row.metrics_sampled === 1,
      revision: row.revision,
    });
  }

  public saveStatisticsWindowMetrics(
    windowStart: string,
    viewerCount: number | null,
    chatters: number | null,
  ): Promise<void> {
    const parsed = Date.parse(windowStart);
    if (!Number.isSafeInteger(parsed)) return Promise.resolve();
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `UPDATE ${STATISTICS_CHAT_WINDOW_TABLE}
          SET viewer_count = ?, chatters = ?, metrics_sampled = 1,
              dirty = 1, revision = revision + 1
        WHERE window_start = ? AND metrics_sampled = 0`,
      viewerCount,
      chatters,
      parsed,
    );
    return Promise.resolve();
  }

  public markStatisticsWindowClean(windowStart: string, revision: number): Promise<void> {
    const parsed = Date.parse(windowStart);
    if (!Number.isSafeInteger(parsed) || !Number.isSafeInteger(revision)) return Promise.resolve();
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `UPDATE ${STATISTICS_CHAT_WINDOW_TABLE} SET dirty = 0
        WHERE window_start = ? AND revision = ?`,
      parsed,
      revision,
    );
    return Promise.resolve();
  }

  public pruneExpiredStatisticsWindows(now: number): Promise<void> {
    if (!Number.isSafeInteger(now)) return Promise.resolve();
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `DELETE FROM ${STATISTICS_CHAT_WINDOW_TABLE}
        WHERE window_start + ? + ? < ?`,
      STATISTICS_WINDOW_MILLISECONDS,
      STATISTICS_WINDOW_RETENTION_MS,
      now,
    );
    return Promise.resolve();
  }

  public hasStatisticsWindows(): Promise<boolean> {
    this.ensureStatisticsSchema();
    const present = this.ctx.storage.sql.exec<{ present: number }>(
      `SELECT EXISTS (SELECT 1 FROM ${STATISTICS_CHAT_WINDOW_TABLE}) AS present`,
    ).one().present;
    return Promise.resolve(present === 1);
  }

  public markStatisticsClipImportPending(
    streamId: string,
    startedAt: string | null,
    endedAt: string,
  ): Promise<void> {
    const endedAtMs = Date.parse(endedAt);
    if (streamId.length === 0 || !Number.isSafeInteger(endedAtMs)) return Promise.resolve();
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO ${STATISTICS_CLIP_IMPORT_TABLE}
         (stream_id, started_at, ended_at, ready_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET
         started_at = CASE
           WHEN started_at IS NULL THEN excluded.started_at
           WHEN excluded.started_at IS NULL THEN started_at
           WHEN julianday(excluded.started_at) < julianday(started_at) THEN excluded.started_at
           ELSE started_at
         END,
         ended_at = MAX(ended_at, excluded.ended_at),
         ready_at = MAX(ready_at, excluded.ready_at),
         expires_at = MAX(expires_at, excluded.expires_at)`,
      streamId,
      startedAt !== null && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
      endedAtMs,
      endedAtMs + STATISTICS_WORD_STREAM_IDLE_MILLISECONDS,
      endedAtMs + STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS,
    );
    return Promise.resolve();
  }

  public listReadyStatisticsClipImports(now: number): Promise<readonly ModuleStatisticsClipImport[]> {
    if (!Number.isSafeInteger(now)) return Promise.resolve([]);
    this.ensureStatisticsSchema();
    const rows = this.ctx.storage.sql.exec<{ stream_id: string; started_at: string | null; ended_at: number }>(
      `SELECT stream_id, started_at, ended_at FROM ${STATISTICS_CLIP_IMPORT_TABLE}
        WHERE ready_at <= ? AND expires_at > ? ORDER BY ended_at ASC`,
      now,
      now,
    ).toArray();
    return Promise.resolve(rows.map(({ stream_id: streamId, started_at: startedAt, ended_at: endedAt }) => ({
      streamId,
      startedAt,
      endedAt: new Date(endedAt).toISOString(),
    })));
  }

  public completeStatisticsClipImport(streamId: string, endedAt: string): Promise<void> {
    const endedAtMs = Date.parse(endedAt);
    if (!Number.isSafeInteger(endedAtMs)) return Promise.resolve();
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `DELETE FROM ${STATISTICS_CLIP_IMPORT_TABLE} WHERE stream_id = ? AND ended_at = ?`,
      streamId,
      endedAtMs,
    );
    return Promise.resolve();
  }

  public pruneExpiredStatisticsClipImports(now: number): Promise<void> {
    if (!Number.isSafeInteger(now)) return Promise.resolve();
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `DELETE FROM ${STATISTICS_CLIP_IMPORT_TABLE} WHERE expires_at <= ?`,
      now,
    );
    return Promise.resolve();
  }

  public hasStatisticsClipImports(): Promise<boolean> {
    this.ensureStatisticsSchema();
    const present = this.ctx.storage.sql.exec<{ present: number }>(
      `SELECT EXISTS (SELECT 1 FROM ${STATISTICS_CLIP_IMPORT_TABLE}) AS present`,
    ).one().present;
    return Promise.resolve(present === 1);
  }

  public markStatisticsWordStreamEnded(streamId: string, endedAt: string): Promise<void> {
    const parsed = Date.parse(endedAt);
    if (streamId.length === 0) return Promise.resolve();
    const endedAtMs = Number.isFinite(parsed) ? parsed : Date.now();
    this.statisticsWordStreamEndedAt.set(streamId, endedAtMs);
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `UPDATE ${STATISTICS_WORD_STREAM_TABLE}
          SET ended_at = COALESCE(ended_at, ?),
              expires_at = COALESCE(ended_at, ?) + ?
        WHERE stream_id = ?`,
      endedAtMs,
      endedAtMs,
      STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS,
      streamId,
    );
    return Promise.resolve();
  }

  public reconcileStatisticsWordStreams(
    streamState: ModuleStatisticsStreamState,
    streamId: string | null,
    observedAt: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(observedAt)) return Promise.resolve();
    this.ensureStatisticsSchema();
    const expiresAt = observedAt + STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS;
    if (streamState === "unknown") return Promise.resolve();
    if (streamState === "online" && streamId !== null) {
      this.ctx.storage.sql.exec(
        `UPDATE ${STATISTICS_WORD_STREAM_TABLE}
            SET ended_at = ?, expires_at = ?
          WHERE stream_id <> ? AND ended_at IS NULL`,
        observedAt,
        expiresAt,
        streamId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE ${STATISTICS_WORD_STREAM_TABLE}
            SET ended_at = NULL, expires_at = MAX(expires_at, ?)
          WHERE stream_id = ?`,
        expiresAt,
        streamId,
      );
    } else if (streamState === "online") {
      this.ctx.storage.sql.exec(
        `UPDATE ${STATISTICS_WORD_STREAM_TABLE} SET expires_at = MAX(expires_at, ?)
          WHERE ended_at IS NULL`,
        expiresAt,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE ${STATISTICS_WORD_STREAM_TABLE}
            SET ended_at = COALESCE(ended_at, ?),
                expires_at = COALESCE(ended_at, ?) + ?
          WHERE ended_at IS NULL`,
        observedAt,
        observedAt,
        STATISTICS_WORD_STREAM_RETENTION_MILLISECONDS,
      );
    }
    return Promise.resolve();
  }

  public listMergeableStatisticsWordBuckets(
    streamState: ModuleStatisticsStreamState,
    streamId: string | null,
    idleBefore: number,
  ): Promise<readonly ModuleStatisticsWordBucket[]> {
    if (!Number.isSafeInteger(idleBefore) || streamState === "unknown" ||
        streamState === "online" && streamId === null) {
      return Promise.resolve([]);
    }
    this.ensureStatisticsSchema();
    // The idle test belongs in HAVING only: a WHERE on the row would hide a fresh word and let a busy bucket pass.
    const activeFilter = streamState === "online" ? "WHERE counts.stream_id <> ?" : "";
    const bindings = streamState === "online" ? [streamId, idleBefore] : [idleBefore];
    const rows = this.ctx.storage.sql.exec<{ stream_id: string; batch: number }>(
      `SELECT counts.stream_id, counts.batch
         FROM ${STATISTICS_WORD_COUNT_TABLE} AS counts
        ${activeFilter}
        GROUP BY counts.stream_id, counts.batch
       HAVING MAX(counts.last_increment_at) <= ?
        ORDER BY counts.stream_id ASC, counts.batch ASC`,
      ...bindings,
    ).toArray();
    return Promise.resolve(rows
      .filter(({ stream_id: bucketStreamId }) => !this.hasFreshBufferedStatisticsWords(bucketStreamId, idleBefore))
      .map(({ stream_id: bucketStreamId, batch }) => ({ streamId: bucketStreamId, batch })));
  }

  /** True when a stream received a word increment newer than `idleBefore` that is not flushed yet. */
  private hasFreshBufferedStatisticsWords(streamId: string, idleBefore: number): boolean {
    const bufferedAt = this.statisticsWordLastBufferedIncrementAt.get(streamId);
    return bufferedAt !== undefined && bufferedAt > idleBefore;
  }

  public prepareStatisticsWordBucketForMerge(
    bucket: ModuleStatisticsWordBucket,
    streamState: ModuleStatisticsStreamState,
    streamId: string | null,
    idleBefore: number,
  ): Promise<readonly ModuleStatisticsWordCount[]> {
    if (!Number.isSafeInteger(idleBefore) || streamState === "unknown" ||
        streamState === "online" && (streamId === null || bucket.streamId === streamId)) return Promise.resolve([]);
    this.ensureStatisticsSchema();
    // Activity buffered after the alarm's flush is invisible to the persisted timestamps below.
    if (this.hasFreshBufferedStatisticsWords(bucket.streamId, idleBefore)) return Promise.resolve([]);
    const rows = this.ctx.storage.transactionSync(() => {
      const lastIncrement = this.ctx.storage.sql.exec<{ last_increment_at: number | null }>(
        `SELECT MAX(last_increment_at) AS last_increment_at FROM ${STATISTICS_WORD_COUNT_TABLE}
          WHERE stream_id = ? AND batch = ?`,
        bucket.streamId,
        bucket.batch,
      ).one().last_increment_at;
      if (lastIncrement === null || lastIncrement > idleBefore) return [];
      const currentBatch = this.ctx.storage.sql.exec<{ current_batch: number }>(
        `SELECT current_batch FROM ${STATISTICS_WORD_STREAM_TABLE} WHERE stream_id = ?`,
        bucket.streamId,
      ).toArray()[0]?.current_batch;
      if (currentBatch === undefined) return [];
      const wordRows = this.ctx.storage.sql.exec<{
        word: string;
        count: number;
        last_seen_at: string;
      }>(
        `SELECT word, count, last_seen_at FROM ${STATISTICS_WORD_COUNT_TABLE}
          WHERE stream_id = ? AND batch = ?
          ORDER BY count DESC, word ASC LIMIT 1000`,
        bucket.streamId,
        bucket.batch,
      ).toArray();
      if (wordRows.length === 0) return [];
      if (currentBatch === bucket.batch) {
        this.ctx.storage.sql.exec(
          `UPDATE ${STATISTICS_WORD_STREAM_TABLE} SET current_batch = current_batch + 1
            WHERE stream_id = ? AND current_batch = ?`,
          bucket.streamId,
          bucket.batch,
        );
      }
      return wordRows.map(({ word, count, last_seen_at: lastSeenAt }) => ({ word, count, lastSeenAt }));
    });
    return Promise.resolve(rows);
  }

  public deleteStatisticsWordBucket(bucket: ModuleStatisticsWordBucket): Promise<void> {
    this.ensureStatisticsSchema();
    this.ctx.storage.sql.exec(
      `DELETE FROM ${STATISTICS_WORD_COUNT_TABLE} WHERE stream_id = ? AND batch = ?`,
      bucket.streamId,
      bucket.batch,
    );
    return Promise.resolve();
  }

  public readStatisticsWordCounts(
    streamId: string,
  ): Promise<readonly { word: string; count: number; lastSeenAt: string }[]> {
    this.ensureStatisticsSchema();
    const rows = this.ctx.storage.sql.exec<{ word: string; count: number; last_seen_at: string }>(
      `SELECT word, SUM(count) AS count, MAX(last_seen_at) AS last_seen_at
         FROM ${STATISTICS_WORD_COUNT_TABLE}
        WHERE stream_id = ? GROUP BY word ORDER BY count DESC, word ASC LIMIT 1000`,
      streamId,
    ).toArray();
    return Promise.resolve(rows.map(({ word, count, last_seen_at: lastSeenAt }) => ({ word, count, lastSeenAt })));
  }

  public pruneExpiredStatisticsWordStreams(now: number): Promise<void> {
    if (!Number.isSafeInteger(now)) return Promise.resolve();
    this.ensureStatisticsSchema();
    this.ctx.storage.transactionSync(() => {
      this.pruneExpiredStatisticsWordStreamsSync(now);
    });
    return Promise.resolve();
  }

  public hasStatisticsWordStreams(): Promise<boolean> {
    this.ensureStatisticsSchema();
    if (this.statisticsWordCounts.size > 0) return Promise.resolve(true);
    const present = this.ctx.storage.sql.exec<{ present: number }>(
      `SELECT EXISTS (SELECT 1 FROM ${STATISTICS_WORD_STREAM_TABLE}) AS present`,
    ).one().present;
    return Promise.resolve(present === 1);
  }

  /** Claims a verified channel.chat.message ID in the time-bounded replay set. */
  public claimEventSubMessage(messageId: string, receivedAt = Date.now()): Promise<"claimed" | "duplicate"> {
    if (messageId.length === 0 || messageId.length > 512 || !Number.isSafeInteger(receivedAt)) {
      return Promise.resolve("duplicate");
    }
    this.ensureEventSubMessageIdTable();
    return Promise.resolve(this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM ${EVENTSUB_MESSAGE_ID_TABLE} WHERE received_at < ?`,
        receivedAt - EVENTSUB_MESSAGE_ID_RETENTION_MS,
      );
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO ${EVENTSUB_MESSAGE_ID_TABLE} (message_id, received_at) VALUES (?, ?)`,
        messageId,
        receivedAt,
      );
      const isNew = this.ctx.storage.sql.exec<{ changes: number }>(
        "SELECT changes() AS changes",
      ).one().changes > 0;
      return isNew ? "claimed" : "duplicate";
    }));
  }

  public async clearActiveChatters(): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        this.clearActiveChatterStateSync();
      });
      await this.scheduleEarliestAlarm();
    });
  }

  public async getActiveChatterCount(windowMs: number): Promise<number> {
    await this.ensurePointRoundRecovery();
    if (!Number.isFinite(windowMs) || windowMs <= 0) return Promise.resolve(0);
    const now = Date.now();
    const key = this.activeChatterKeyRowSync();
    if (key === null || now - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) return Promise.resolve(0);
    const cutoff = Math.max(now - windowMs, now - ACTIVE_CHATTER_RETENTION_MS);
    this.ensureActiveChatterTable();
    const result = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${ACTIVE_CHATTER_TABLE} WHERE last_seen_at >= ?`,
      new Date(cutoff).toISOString(),
    ).one();
    return Promise.resolve(result.count);
  }

  public async getActiveChatter(userId: string): Promise<ActiveChatterActivity | null> {
    await this.ensurePointRoundRecovery();
    if (userId.length === 0) return null;
    this.ensureActiveChatterTable();
    const key = this.activeChatterKeyRowSync();
    if (key === null || Date.now() - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) return null;
    const hmac = await activeChatterKey(key.keyHex, this.ownChannelId() ?? "", userId);
    const activity = this.ctx.storage.sql.exec<{ first_seen_at: string; last_seen_at: string }>(
      `SELECT first_seen_at, last_seen_at FROM ${ACTIVE_CHATTER_TABLE}
       WHERE hmac = ? AND last_seen_at >= ?`,
      hmac,
      new Date(Date.now() - ACTIVE_CHATTER_RETENTION_MS).toISOString(),
    ).toArray()[0];
    return activity === undefined
      ? null
      : { firstSeenAt: activity.first_seen_at, lastSeenAt: activity.last_seen_at };
  }

  /** Reads active chatter state without initializing storage tables or changing alarms. */
  public async getActiveChatterSnapshot(userId: string): Promise<ActiveChatterActivity | null> {
    if (userId.length === 0) return null;
    const key = this.activeChatterKeyRowSnapshot();
    if (key === null || Date.now() - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) return null;
    try {
      const hmac = await activeChatterKey(key.keyHex, this.ownChannelId() ?? "", userId);
      const activity = this.ctx.storage.sql.exec<{ first_seen_at: string; last_seen_at: string }>(
        `SELECT first_seen_at, last_seen_at FROM ${ACTIVE_CHATTER_TABLE}
         WHERE hmac = ? AND last_seen_at >= ?`,
        hmac,
        new Date(Date.now() - ACTIVE_CHATTER_RETENTION_MS).toISOString(),
      ).toArray()[0];
      return activity === undefined
        ? null
        : { firstSeenAt: activity.first_seen_at, lastSeenAt: activity.last_seen_at };
    } catch {
      return null;
    }
  }

  /** Reads the active chatter count without initializing storage tables or changing alarms. */
  public getActiveChatterCountSnapshot(windowMs: number): Promise<number> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return Promise.resolve(0);
    const now = Date.now();
    const key = this.activeChatterKeyRowSnapshot();
    if (key === null || now - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) return Promise.resolve(0);
    const cutoff = Math.max(now - windowMs, now - ACTIVE_CHATTER_RETENTION_MS);
    try {
      const result = this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${ACTIVE_CHATTER_TABLE} WHERE last_seen_at >= ?`,
        new Date(cutoff).toISOString(),
      ).one();
      return Promise.resolve(result.count);
    } catch {
      return Promise.resolve(0);
    }
  }

  private async expireActiveChatters(_deadline: number, now: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.transactionSync(() => {
        this.ensureActiveChatterTable();
        this.ctx.storage.sql.exec(
          `DELETE FROM ${ACTIVE_CHATTER_TABLE} WHERE last_seen_at <= ?`,
          new Date(now - ACTIVE_CHATTER_RETENTION_MS).toISOString(),
        );
        const key = this.activeChatterKeyRowSync();
        if (key !== null && now - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) {
          this.clearActiveChatterStateSync();
          return;
        }
        const nextSweep = key === null ? null : this.activeChatterNextSweepSync(key.createdAt);
        if (nextSweep === null) this.clearActiveChatterStateSync();
        else this.writeActiveChatterExpiryEntrySync(nextSweep);
      });
      return Promise.resolve();
    });
  }

  public async claimAutomatedChatOutput(): Promise<boolean> {
    await this.ensurePointRoundRecovery();
    return claimAutomatedChatOutput(this.ctx.storage, Date.now());
  }

  public async isRecentBotChatMessage(senderId: string | null, text: string): Promise<boolean> {
    await this.ensurePointRoundRecovery();
    return isRecentBotChatMessage(this.ctx.storage, senderId, text, Date.now());
  }

  public async recordBotChatMessage(senderId: string, text: string): Promise<void> {
    await this.ensurePointRoundRecovery();
    await recordRecentBotChatMessage(this.ctx.storage, senderId, text, Date.now());
  }

  public async getChatActivityCount(): Promise<number> {
    await this.ensurePointRoundRecovery();
    const current = await this.ctx.storage.get<number>(CHAT_ACTIVITY_COUNT_KEY);
    return typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current : 0;
  }

  private writePointRoundAlarmSync(key: string, deadline: number): void {
    const stored = this.ctx.storage.kv.get<AlarmScheduleTable>(ALARM_TABLE_KEY);
    const table = stored === undefined ? {} : { ...stored };
    table[key] = {
      deadline,
      handler: POINTS_ROUND_ALARM_HANDLER,
      revision: (table[key]?.revision ?? 0) + 1,
    };
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private writePointCancellationNoticeAlarmSync(moduleId: string, revision: number, deadline: number): void {
    const key = pointCancellationNoticeAlarmKey(moduleId, revision);
    const stored = this.ctx.storage.kv.get<AlarmScheduleTable>(ALARM_TABLE_KEY);
    const table = stored === undefined ? {} : { ...stored };
    table[key] = {
      deadline,
      handler: POINTS_CANCELLATION_NOTICE_ALARM_HANDLER,
      revision: (table[key]?.revision ?? 0) + 1,
    };
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private ensurePointCancellationNoticeAlarmsSync(): void {
    const stored = this.ctx.storage.kv.get<AlarmScheduleTable>(ALARM_TABLE_KEY);
    const table = stored === undefined ? {} : { ...stored };
    let changed = false;
    for (const notice of pendingPointRoundCancellationNotices(this.ctx.storage.sql)) {
      const key = pointCancellationNoticeAlarmKey(notice.moduleId, notice.revision);
      if (table[key]?.handler === POINTS_CANCELLATION_NOTICE_ALARM_HANDLER) continue;
      table[key] = {
        deadline: Date.now(),
        handler: POINTS_CANCELLATION_NOTICE_ALARM_HANDLER,
        revision: (table[key]?.revision ?? 0) + 1,
      };
      changed = true;
    }
    if (changed) this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private clearPointRoundAlarmSync(key: string): void {
    const stored = this.ctx.storage.kv.get<AlarmScheduleTable>(ALARM_TABLE_KEY);
    if (stored === undefined || stored[key] === undefined) return;
    const table = { ...stored };
    Reflect.deleteProperty(table, key);
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private async recoverPointRoundAlarms(): Promise<void> {
    this.ensurePointsSchema();
    const cancellations = pendingPointRoundCancellations(this.ctx.storage.sql);
    const activeModuleIds = this.ctx.storage.sql.exec<{ module_id: string }>(
      "SELECT DISTINCT module_id FROM game_rounds WHERE state IN ('announcing', 'open', 'resolving')",
    ).toArray().map(({ module_id }) => module_id);
    this.retainPointActivationReconciliationModulesSync([
      ...activeModuleIds,
      ...cancellations.map(({ moduleId }) => moduleId),
    ]);
    for (const cancellation of cancellations) {
      await this.cancelOpenGameRoundsInternal(cancellation.moduleId, cancellation.revision, false);
    }
    const rounds = recoverablePointRounds(this.ctx.storage.sql);
    const table = await this.ensureAlarmScheduleTable();
    const now = Date.now();
    for (const round of rounds) {
      const alarmKey = pointRoundAlarmKey(round.round_id);
      if (round.state === "open" && round.deadline_at !== null && round.deadline_at + 60_000 < now) {
        console.error(`Point round ${round.round_id} is stuck past its resolution grace period.`);
      }
      if (table[alarmKey] !== undefined) continue;
      let deadline = round.deadline_at ?? now;
      if (round.state === "announcing") {
        if (round.announce_state === "rate_limited" && round.last_attempt_at !== null) {
          deadline = round.last_attempt_at + POINTS_ANNOUNCE_RETRY_MS;
        } else if (round.announce_state === "pending" && round.announce_attempts >= POINTS_ANNOUNCE_MAX_ATTEMPTS &&
            round.last_attempt_at !== null) {
          deadline = round.last_attempt_at + POINTS_ANNOUNCE_AMBIGUOUS_MS;
        } else if (round.announce_state === "failed") {
          deadline = now;
        } else if (round.announce_state === "pending") {
          deadline = now;
        }
      }
      this.ctx.storage.transactionSync(() => { this.writePointRoundAlarmSync(alarmKey, deadline); });
    }
    if (this.pointActivationReconciliationModulesSync().length > 0) {
      const current = table[POINTS_ACTIVATION_RECONCILIATION_ALARM_KEY];
      if (current?.handler !== POINTS_ACTIVATION_RECONCILIATION_ALARM_HANDLER) {
        this.ctx.storage.transactionSync(() => {
          this.writePointActivationReconciliationAlarmSync(now);
        });
      }
    }
    for (const notice of pendingPointRoundCancellationNotices(this.ctx.storage.sql)) {
      const key = pointCancellationNoticeAlarmKey(notice.moduleId, notice.revision);
      if (table[key] !== undefined) continue;
      this.ctx.storage.transactionSync(() => {
        this.writePointCancellationNoticeAlarmSync(notice.moduleId, notice.revision, now);
      });
    }
    await this.scheduleEarliestAlarm();
  }

  private async reconcilePointModuleActivationsDuringRecovery(): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    const moduleIds = new Set(this.pointActivationReconciliationModulesSync());
    for (const { module_id: moduleId } of this.ctx.storage.sql.exec<{ module_id: string }>(
      `SELECT module_id FROM game_rounds WHERE state IN ('announcing', 'open', 'resolving')
       UNION SELECT module_id FROM game_round_cancellations`,
    ).toArray()) moduleIds.add(moduleId);
    if (moduleIds.size === 0) return;

    const requestedModuleIds = [...moduleIds].sort((left, right) => left.localeCompare(right));
    for (const batch of chunksOf(requestedModuleIds, D1_IDS_PER_QUERY)) {
      const placeholders = batch.map(() => "?").join(", ");
      const activations = await this.env.DB.prepare(
        `SELECT module_id, enabled, revision, last_disabled_revision FROM channel_modules
          WHERE channel_id = ? AND module_id IN (${placeholders})`,
      ).bind(channelId, ...batch).all<{
        module_id: string;
        enabled: number;
        revision: number;
        last_disabled_revision: number | null;
      }>();
      for (const activation of activations.results) {
        await this.applyPointModuleActivation(
          activation.module_id,
          activation.enabled === 1,
          activation.revision,
          false,
          activation.last_disabled_revision,
        );
      }
    }
    this.clearPointActivationReconciliationModulesSync(requestedModuleIds);
  }

  private async reconcilePointModuleActivation(moduleId: string, flushCancellationNotices: boolean): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    const activation = await this.env.DB.prepare(
      "SELECT enabled, revision, last_disabled_revision FROM channel_modules WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, moduleId).first<{
      enabled: number;
      revision: number;
      last_disabled_revision: number | null;
    }>();
    if (activation === null) return;
    await this.applyPointModuleActivation(
      moduleId,
      activation.enabled === 1,
      activation.revision,
      flushCancellationNotices,
      activation.last_disabled_revision,
    );
  }

  private async applyPointModuleActivation(
    moduleId: string,
    enabled: boolean,
    revision: number,
    flushCancellationNotices: boolean,
    lastDisabledRevision: number | null = null,
  ): Promise<void> {
    if (enabled && lastDisabledRevision !== null) {
      await this.setGameModuleGateInternal(moduleId, false, revision, flushCancellationNotices, lastDisabledRevision);
      return;
    }

    if (lastDisabledRevision !== null) {
      const currentGate = this.ctx.storage.sql.exec<{ revision: number }>(
        "SELECT revision FROM module_gates WHERE module_id = ?",
        moduleId,
      ).toArray()[0];
      if (currentGate === undefined || currentGate.revision < lastDisabledRevision) {
        const disabled = await this.setGameModuleGateInternal(moduleId, true, lastDisabledRevision, flushCancellationNotices);
        if (disabled.applied) await this.cancelOpenGameRoundsInternal(moduleId, lastDisabledRevision, flushCancellationNotices);
      } else {
        await this.cancelOpenGameRoundsInternal(moduleId, lastDisabledRevision, flushCancellationNotices);
      }
    }

    const gate = this.ctx.storage.sql.exec<{ revision: number }>(
      "SELECT revision FROM module_gates WHERE module_id = ?",
      moduleId,
    ).toArray()[0];
    if (gate !== undefined && revision <= gate.revision) return;
    const result = await this.setGameModuleGateInternal(moduleId, !enabled, revision, flushCancellationNotices);
    if (result.applied && !enabled) {
      await this.cancelOpenGameRoundsInternal(moduleId, revision, flushCancellationNotices);
    }
  }

  private writePointActivationReconciliationAlarmSync(deadline: number): void {
    const stored = this.ctx.storage.kv.get<AlarmScheduleTable>(ALARM_TABLE_KEY);
    const table = stored === undefined ? {} : { ...stored };
    table[POINTS_ACTIVATION_RECONCILIATION_ALARM_KEY] = {
      deadline,
      handler: POINTS_ACTIVATION_RECONCILIATION_ALARM_HANDLER,
      revision: (table[POINTS_ACTIVATION_RECONCILIATION_ALARM_KEY]?.revision ?? 0) + 1,
    };
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private pointActivationReconciliationModulesSync(): string[] {
    const stored = this.ctx.storage.kv.get(POINTS_ACTIVATION_RECONCILIATION_MODULES_KEY);
    return Array.isArray(stored)
      ? [...new Set(stored.filter((value): value is string => typeof value === "string" && value.length > 0))]
        .sort((left, right) => left.localeCompare(right))
      : [];
  }

  private retainPointActivationReconciliationModulesSync(moduleIds: readonly string[]): void {
    const modules = new Set([...this.pointActivationReconciliationModulesSync(), ...moduleIds]);
    if (modules.size > 0) {
      this.ctx.storage.kv.put(POINTS_ACTIVATION_RECONCILIATION_MODULES_KEY,
        [...modules].sort((left, right) => left.localeCompare(right)));
    }
  }

  private clearPointActivationReconciliationModulesSync(moduleIds: readonly string[]): void {
    this.ctx.storage.transactionSync(() => {
      const modules = new Set(this.pointActivationReconciliationModulesSync());
      for (const moduleId of moduleIds) modules.delete(moduleId);
      if (modules.size === 0) this.ctx.storage.kv.delete(POINTS_ACTIVATION_RECONCILIATION_MODULES_KEY);
      else this.ctx.storage.kv.put(POINTS_ACTIVATION_RECONCILIATION_MODULES_KEY,
        [...modules].sort((left, right) => left.localeCompare(right)));
    });
  }

  private pointAccess(moduleId: string): ModulePointsAccess {
    return {
      apply: (operationId, kind, movements, result, payloadIdentity) =>
        this.applyPointOperation(moduleId, operationId, kind, movements, result, payloadIdentity),
      settle: (operationId, kind, actor, stake, params, options) =>
        this.settlePointOperation(moduleId, operationId, kind, actor, stake, params, options),
      touchAccount: (accountId, login, startBonus) => this.touchPointAccount(moduleId, accountId, login, startBonus),
      ackWelcome: (accountId) => this.acknowledgePointWelcome(moduleId, accountId),
      creditActivity: (accountId, login, messageAt, live, rules) =>
        this.creditPointActivity(moduleId, accountId, login, messageAt, live, rules),
      balance: (accountId) => this.pointBalance(moduleId, accountId),
      getAccount: (accountId) => this.pointAccount(moduleId, accountId),
      listAccounts: (query) => this.listPointAccounts(moduleId, query),
      history: (accountId, cursor, limit) => this.pointHistory(moduleId, accountId, cursor, limit),
      summary: () => this.pointSummary(moduleId),
      ranking: (month, limit) => this.pointRanking(moduleId, month, limit),
      rankOf: (accountId, month) => this.pointRankOf(moduleId, accountId, month),
      markAuditWritten: (operationId) => this.markPointAuditWritten(moduleId, operationId),
      pendingAudits: () => this.pendingPointAudits(moduleId),
      claimCooldown: (key, seconds) => this.claimPointCooldown(moduleId, key, seconds),
      rounds: {
        open: (roundId, data) => this.openGameRound(moduleId, roundId, data),
        openWithStake: (roundId, data, operationId, accountId, login, stake, cooldown) =>
          this.openGameRoundWithStake(moduleId, roundId, data, operationId, accountId, login, stake, cooldown),
        active: () => this.activeGameRound(moduleId),
        listOpen: () => this.listOpenGameRounds(moduleId),
        markAnnounced: (roundId, deadlineAt, alarmKey) => this.markGameRoundAnnounced(moduleId, roundId, deadlineAt, alarmKey),
        join: (roundId, operationId, accountId, login, stake, data) =>
          this.joinGameRound(moduleId, roundId, operationId, accountId, login, stake, data),
        participants: (roundId, nameLimit) => this.gameRoundParticipants(moduleId, roundId, nameLimit),
        answer: (roundId, operationId, accountId, login, graceS, messageAt) =>
          this.answerGameRound(moduleId, roundId, operationId, accountId, login, graceS, messageAt),
        attack: (roundId, operationId, accountId, login, damage, messageAt) =>
          this.attackGameRound(moduleId, roundId, operationId, accountId, login, damage, messageAt),
        resolve: (roundId, settlement) => this.resolveGameRound(moduleId, roundId, settlement),
        accept: (roundId, operationId, accountId, login, replyToMessageId) =>
          this.acceptGameRound(moduleId, roundId, operationId, accountId, login, replyToMessageId),
        cancel: (roundId) => this.cancelGameRound(moduleId, roundId),
        cancelOpenRounds: (revision) => this.cancelOpenGameRounds(moduleId, revision),
        setGate: (closed, revision, lastDisabledRevision) =>
          this.setGameModuleGate(moduleId, closed, revision, lastDisabledRevision),
      },
    };
  }

  public async applyPointOperation(
    moduleId: string,
    operationId: string,
    kind: PointsKind,
    movements: PointsMovement[],
    result: unknown,
    payloadIdentity?: unknown,
  ): Promise<PointsApplyResult> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    const canonicalResult = canonicalPointResult(result);
    const payloadHash = await pointPayloadHash(payloadIdentity === undefined
      ? { moduleId, operationId, kind, movements, result: canonicalResult.value }
      : { moduleId, operationId, kind, movements, identity: payloadIdentity });
    const applied = this.ctx.storage.transactionSync(() => applyPointOperationSync(
      this.ctx.storage.sql,
      moduleId,
      operationId,
      kind,
      movements,
      result,
      payloadHash,
      new Date().toISOString(),
      canonicalResult,
    ));
    return { replayed: applied.replayed, result: applied.result, balances: applied.balances };
  }

  public async settlePointOperation(
    moduleId: string,
    operationId: string,
    kind: string,
    actor: { accountId: string; login: string },
    stake: number,
    params: unknown,
    options: { payloadIdentity: unknown; cooldown?: PointSettlementCooldown },
  ): Promise<PointsApplyResult> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    const payloadHash = await pointPayloadHash({ moduleId, kind, identity: options.payloadIdentity });
    const applied = this.ctx.storage.transactionSync(() => settlePointOperationSync(
      this.ctx.storage.sql,
      moduleId,
      operationId,
      actor,
      stake,
      params,
      INSTANT_SETTLEMENTS.get(kind),
      payloadHash,
      new Date().toISOString(),
      options.cooldown,
    ));
    return { replayed: applied.replayed, result: applied.result, balances: applied.balances };
  }

  public async touchPointAccount(
    moduleId: string,
    accountId: string,
    login: string,
    startBonus: number,
  ): Promise<{ welcomePending: boolean; startBonus: number | null }> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointAccountId(accountId);
    const operationId = `bonus:${accountId}`;
    const movements: PointsMovement[] = [
      { accountId, delta: startBonus, login },
      { accountId: "__house", delta: -startBonus },
    ];
    const payloadHash = await pointPayloadHash({
      moduleId,
      operationId,
      kind: "bonus",
      movements,
      result: { amount: startBonus },
    });
    return this.ctx.storage.transactionSync(() => touchPointAccountSync(
      this.ctx.storage.sql,
      moduleId,
      accountId,
      login,
      startBonus,
      payloadHash,
      new Date().toISOString(),
    ));
  }

  public async acknowledgePointWelcome(_moduleId: string, accountId: string, roundId?: string): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointAccountId(accountId);
    this.ctx.storage.transactionSync(() => {
      acknowledgeWelcomeSync(this.ctx.storage.sql, accountId, new Date().toISOString());
      if (roundId === undefined) return;
      const round = pointRoundRow(this.ctx.storage.sql, roundId);
      if (round === null) return;
      const data: unknown = JSON.parse(round.data_json);
      const pending = isRecord(data) ? data[POINT_WELCOME_ROUND_DATA_KEY] : undefined;
      if (!isRecord(data) || !isRecord(pending) || pending.accountId !== accountId) return;
      Reflect.deleteProperty(data, POINT_WELCOME_ROUND_DATA_KEY);
      this.ctx.storage.sql.exec("UPDATE game_rounds SET data_json = ? WHERE round_id = ?", JSON.stringify(data), roundId);
    });
  }

  public async creditPointActivity(
    moduleId: string,
    accountId: string,
    login: string,
    messageAt: number,
    live: boolean,
    rules: { amount: number; windowMinutes: number; dailyCap: number },
  ): Promise<{ credited: number }> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointAccountId(accountId);
    const windowStart = Math.floor(messageAt / (rules.windowMinutes * 60_000)) * rules.windowMinutes * 60_000;
    const operationId = `activity:${accountId}:${String(windowStart)}`;
    const payloadHash = await pointPayloadHash({ moduleId, operationId, kind: "activity", accountId });
    return this.ctx.storage.transactionSync(() => creditPointActivitySync(
      this.ctx.storage.sql,
      moduleId,
      accountId,
      login,
      messageAt,
      live,
      rules,
      () => payloadHash,
      new Date().toISOString(),
    ));
  }

  public async pointBalance(_moduleId: string, accountId: string): Promise<number> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointAccountId(accountId);
    return pointBalance(this.ctx.storage.sql, accountId);
  }

  public async pointAccount(_moduleId: string, accountId: string): Promise<Awaited<ReturnType<ModulePointsAccess["getAccount"]>>> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointAccountId(accountId);
    return pointAccount(this.ctx.storage.sql, accountId);
  }

  public async listPointAccounts(
    _moduleId: string,
    query: { sort: "balance" | "month"; search?: string; cursor?: string; limit: number },
  ): Promise<Awaited<ReturnType<ModulePointsAccess["listAccounts"]>>> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    return listPointAccounts(this.ctx.storage.sql, query, new Date().toISOString().slice(0, 7));
  }

  public async pointHistory(
    _moduleId: string,
    accountId: string,
    cursor?: string,
    limit?: number,
  ): Promise<Awaited<ReturnType<ModulePointsAccess["history"]>>> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointAccountId(accountId);
    return pointHistory(this.ctx.storage.sql, accountId, cursor, limit);
  }

  public async pointSummary(_moduleId: string): Promise<Awaited<ReturnType<ModulePointsAccess["summary"]>>> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    void _moduleId;
    return pointSummary(this.ctx.storage.sql);
  }

  public async pointRanking(
    _moduleId: string,
    month: string,
    limit: number,
  ): Promise<Awaited<ReturnType<ModulePointsAccess["ranking"]>>> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    return pointRanking(this.ctx.storage.sql, month, limit);
  }

  public async pointRankOf(
    _moduleId: string,
    accountId: string,
    month: string,
  ): Promise<Awaited<ReturnType<ModulePointsAccess["rankOf"]>>> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointAccountId(accountId);
    return pointRankOf(this.ctx.storage.sql, accountId, month);
  }

  public async markPointAuditWritten(moduleId: string, operationId: string): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    this.ctx.storage.transactionSync(() => { pointAuditWrittenSync(this.ctx.storage.sql, moduleId, operationId); });
  }

  public async pendingPointAudits(moduleId: string): Promise<Awaited<ReturnType<ModulePointsAccess["pendingAudits"]>>> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    return pendingPointAudits(this.ctx.storage.sql, moduleId);
  }

  public async claimPointCooldown(moduleId: string, key: string, seconds: number): Promise<boolean> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    return this.ctx.storage.transactionSync(() => claimPointCooldownSync(this.ctx.storage.sql, moduleId, key, seconds, Date.now()));
  }

  /** Reads a cooldown for dry-run explanations without initializing points or changing stored state. */
  public async getPointCooldownRemaining(moduleId: string, key: string, now = Date.now()): Promise<number> {
    return Promise.resolve(this.ctx.storage.transactionSync(() => pointCooldownRemainingSync(this.ctx.storage.sql, moduleId, key, now)));
  }

  public async openGameRound(moduleId: string, roundId: string, data: unknown): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    await this.reconcilePointModuleActivation(moduleId, true);
    const alarmKey = pointRoundAlarmKey(roundId);
    this.ctx.storage.transactionSync(() => {
      const opened = openPointRoundSync(this.ctx.storage.sql, moduleId, roundId, data, new Date().toISOString(), POINT_SETTLEMENTS);
      if (opened.opened) {
        if (MODULES.find((module) => module.id === moduleId)?.onPointRoundOpened !== undefined) {
          this.ctx.storage.sql.exec("UPDATE game_rounds SET prepare_state = 'pending' WHERE round_id = ?", roundId);
        }
        this.writePointRoundAlarmSync(alarmKey, Date.now());
      }
    });
    await this.scheduleEarliestAlarm();
  }

  public async openGameRoundWithStake(
    moduleId: string,
    roundId: string,
    data: unknown,
    operationId: string,
    accountId: string,
    login: string,
    stake: number,
    cooldown?: { key: string; seconds: number },
  ): Promise<{ roundId: string; replayed: boolean }> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    assertPointAccountId(accountId);
    await this.reconcilePointModuleActivation(moduleId, true);
    const requestHash = await pointPayloadHash({ moduleId, operationId, kind: "round_open_stake", data, accountId, login, stake, cooldown });
    let opened: { roundId: string; replayed: boolean; alarmKey: string };
    try {
      opened = this.ctx.storage.transactionSync(() => {
        const value = openPointRoundWithStakeSync(
          this.ctx.storage.sql,
          moduleId,
          roundId,
          data,
          operationId,
          accountId,
          login,
          stake,
          cooldown,
          requestHash,
          Date.now(),
          new Date().toISOString(),
          POINT_SETTLEMENTS,
        );
        if (!value.replayed) {
          if (MODULES.find((module) => module.id === moduleId)?.onPointRoundOpened !== undefined) {
            this.ctx.storage.sql.exec("UPDATE game_rounds SET prepare_state = 'pending' WHERE round_id = ?", value.roundId);
          }
          this.writePointRoundAlarmSync(value.alarmKey, Date.now());
        }
        return value;
      });
    } catch (error) {
      if ((error instanceof Error ? error.message : String(error)) === "insufficient_balance") throw new Error("insufficient_points", { cause: error });
      throw error;
    }
    if (!opened.replayed) await this.scheduleEarliestAlarm();
    return { roundId: opened.roundId, replayed: opened.replayed };
  }

  public async activeGameRound(moduleId: string): Promise<PointActiveRound | null> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    const round = this.ctx.storage.sql.exec<{
      round_id: string;
      state: "announcing" | "open";
      deadline_at: number | null;
      data_json: string;
    }>(
      `SELECT round_id, state, deadline_at, data_json FROM game_rounds
        WHERE module_id = ? AND state IN ('announcing', 'open')
        ORDER BY created_at, round_id LIMIT 1`,
      moduleId,
    ).toArray()[0];
    return round === undefined ? null : {
      roundId: round.round_id,
      state: round.state,
      data: JSON.parse(round.data_json) as unknown,
      deadlineAt: round.deadline_at,
    };
  }

  public async listOpenGameRounds(moduleId: string): Promise<PointActiveRound[]> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    return this.ctx.storage.transactionSync(() => listOpenPointRoundsSync(this.ctx.storage.sql, moduleId));
  }

  public async markGameRoundAnnounced(moduleId: string, roundId: string, deadlineAt: number, alarmKey: string): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    this.ctx.storage.transactionSync(() => {
      markPointRoundAnnouncedSync(this.ctx.storage.sql, moduleId, roundId, deadlineAt, alarmKey);
      this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), deadlineAt);
    });
    await this.scheduleEarliestAlarm();
  }

  public async joinGameRound(
    moduleId: string,
    roundId: string,
    operationId: string,
    accountId: string,
    login: string,
    stake: number,
    data: unknown,
  ): Promise<PointJoinResult> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    assertPointAccountId(accountId);
    const payloadHash = await pointPayloadHash({ moduleId, roundId, operationId, accountId, login, stake, data });
    try {
      return this.ctx.storage.transactionSync(() => joinPointRoundSync(
        this.ctx.storage.sql,
        moduleId,
        roundId,
        operationId,
        accountId,
        login,
        stake,
        data,
        payloadHash,
        Date.now(),
        new Date().toISOString(),
      ));
    } catch (error) {
      // Same code the opening stake reports, so a module handles both alike.
      if ((error instanceof Error ? error.message : String(error)) === "insufficient_balance") throw new Error("insufficient_points", { cause: error });
      throw error;
    }
  }

  public async gameRoundParticipants(moduleId: string, roundId: string, nameLimit: number): Promise<PointRoundParticipants> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    return pointRoundParticipantsSync(this.ctx.storage.sql, moduleId, roundId, nameLimit);
  }

  public async answerGameRound(
    moduleId: string,
    roundId: string,
    operationId: string,
    accountId: string,
    login: string,
    graceS: number,
    messageAt: number,
  ): Promise<PointRoundAnswerResult> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    assertPointAccountId(accountId);
    const payloadHash = await pointPayloadHash({ moduleId, roundId, operationId, accountId, login, graceS, messageAt });
    const answer = this.ctx.storage.transactionSync(() => {
      const result = answerPointRoundSync(
        this.ctx.storage.sql,
        moduleId,
        roundId,
        operationId,
        accountId,
        login,
        graceS,
        messageAt,
        payloadHash,
        Date.now(),
        new Date().toISOString(),
      );
      if (result.status === "recorded" && result.first && result.deadlineAt !== null) {
        this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), result.deadlineAt);
      }
      return result;
    });
    if (answer.status === "recorded" && answer.first) await this.scheduleEarliestAlarm();
    return { status: answer.status, replayed: answer.replayed, first: answer.first };
  }

  public async attackGameRound(
    moduleId: string,
    roundId: string,
    operationId: string,
    accountId: string,
    login: string,
    damage: number,
    messageAt: number,
  ): Promise<Awaited<ReturnType<ModulePointsAccess["rounds"]["attack"]>>> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    assertPointAccountId(accountId);
    // The persisted first result owns its random damage roll, so a retried event stays idempotent.
    const payloadHash = await pointPayloadHash({ moduleId, roundId, operationId, accountId, login, messageAt });
    const cooldownKey = await pointPayloadHash({ purpose: "boss_fight_attack_cooldown", moduleId, roundId, accountId });
    return this.ctx.storage.transactionSync(() => attackPointRoundSync(
      this.ctx.storage.sql,
      moduleId,
      roundId,
      operationId,
      accountId,
      login,
      damage,
      messageAt,
      payloadHash,
      cooldownKey,
      Date.now(),
      new Date().toISOString(),
    ));
  }

  public async resolveGameRound(
    moduleId: string,
    roundId: string,
    settlement: { kind: string; params: unknown },
  ): Promise<PointsApplyResult> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    await this.reconcilePointModuleActivation(moduleId, true);
    const operationId = `round:${roundId}:resolve`;
    const payloadHash = await pointPayloadHash({ moduleId, operationId, kind: "resolve", roundId, settlement });
    let resolved;
    try {
      resolved = this.ctx.storage.transactionSync(() => {
        const value = resolvePointRoundSync(
          this.ctx.storage.sql,
          moduleId,
          roundId,
          settlement,
          POINT_SETTLEMENTS,
          payloadHash,
          new Date().toISOString(),
        );
        if (MODULES.find((module) => module.id === moduleId)?.formatPointRoundResult === undefined) {
          recordPointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId, "delivered");
        }
        const round = pointRoundRow(this.ctx.storage.sql, roundId);
        const alarmKey = pointRoundAlarmKey(roundId);
        if (round?.resolve_delivery_state === "delivered" || round?.resolve_delivery_state === "suppressed" ||
            round?.resolve_delivery_state === "failed") {
          this.clearPointRoundAlarmSync(alarmKey);
        } else this.writePointRoundAlarmSync(alarmKey, Date.now());
        return value;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === "round_cancellation_pending") throw error;
      if (reason === "settlement_missing" || reason === "settlement_unknown" || reason === "settlement_execution_failed" ||
          reason === "monthly_overflow") {
        await this.cancelPointRounds(moduleId, [roundId]);
        throw new Error("round_cancelled", { cause: error });
      }
      throw error;
    }
    await this.scheduleEarliestAlarm();
    try {
      await this.notifyPointRoundResolved(roundId);
    } catch (error) {
      console.error(`Point round ${roundId} lifecycle notification failed.`, error);
    }
    return { replayed: resolved.replayed, result: resolved.result, balances: resolved.balances };
  }

  public async acceptGameRound(
    moduleId: string,
    roundId: string,
    operationId: string,
    accountId: string,
    login: string,
    replyToMessageId?: string,
    pointWelcome?: PointWelcomeNote,
  ): Promise<PointsApplyResult> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    assertPointAccountId(accountId);
    await this.reconcilePointModuleActivation(moduleId, true);
    const requestHash = await pointPayloadHash({
      moduleId, roundId, operationId, kind: "duel_accept", accountId, login, replyToMessageId: replyToMessageId ?? null,
    });
    const settlement = { kind: "duel", params: { mode: "accept" } };
    const resolveOperationId = `round:${roundId}:resolve`;
    const resolveHash = await pointPayloadHash({ moduleId, operationId: resolveOperationId, kind: "resolve", roundId, settlement });
    let resolved;
    try {
      resolved = this.ctx.storage.transactionSync(() => {
        const value = acceptPointRoundSync(
          this.ctx.storage.sql,
          moduleId,
          roundId,
          operationId,
          accountId,
          login,
          requestHash,
          resolveHash,
          Date.now(),
          new Date().toISOString(),
          POINT_SETTLEMENTS,
          replyToMessageId,
          pointWelcome,
        );
        if (MODULES.find((module) => module.id === moduleId)?.formatPointRoundResult === undefined) {
          recordPointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId, "delivered");
        }
        const round = pointRoundRow(this.ctx.storage.sql, roundId);
        const alarmKey = pointRoundAlarmKey(roundId);
        if (round?.resolve_delivery_state === "delivered" || round?.resolve_delivery_state === "suppressed" ||
            round?.resolve_delivery_state === "failed") this.clearPointRoundAlarmSync(alarmKey);
        else this.writePointRoundAlarmSync(alarmKey, Date.now());
        return value;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === "insufficient_balance") throw new Error("insufficient_points", { cause: error });
      if (reason === "round_cancellation_pending") throw error;
      if (reason === "settlement_missing" || reason === "settlement_unknown" || reason === "settlement_execution_failed" ||
          reason === "monthly_overflow") {
        await this.cancelPointRounds(moduleId, [roundId]);
        throw new Error("round_cancelled", { cause: error });
      }
      throw error;
    }
    await this.scheduleEarliestAlarm();
    try {
      await this.notifyPointRoundResolved(roundId);
    } catch (error) {
      console.error(`Point round ${roundId} lifecycle notification failed.`, error);
    }
    return { replayed: resolved.replayed, result: resolved.result, balances: resolved.balances };
  }

  public async cancelGameRound(moduleId: string, roundId: string): Promise<number> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    assertPointRoundId(roundId);
    return this.cancelPointRounds(moduleId, [roundId]);
  }

  public async cancelOpenGameRounds(moduleId: string, revision: number): Promise<number> {
    await this.ensurePointRoundRecovery();
    await this.ensurePointsInitialized();
    return await this.cancelOpenGameRoundsInternal(moduleId, revision, true);
  }

  private async cancelOpenGameRoundsInternal(
    moduleId: string,
    revision: number,
    flushCancellationNotices: boolean,
  ): Promise<number> {
    this.ensurePointsSchema();
    const roundIds = this.ctx.storage.sql.exec<{ round_id: string }>(
      `SELECT round_id FROM game_rounds
        WHERE module_id = ? AND gate_revision < ? AND state IN ('announcing', 'open', 'resolving')
        ORDER BY created_at, round_id`,
      moduleId,
      revision,
    ).toArray().map(({ round_id }) => round_id);
    return await this.cancelPointRounds(moduleId, roundIds, revision, flushCancellationNotices);
  }

  private async cancelPointRounds(
    moduleId: string,
    roundIds: readonly string[],
    expectedGateRevision?: number,
    flushCancellationNotices = true,
  ): Promise<number> {
    const refundRequests = pointRoundRefundRequests(this.ctx.storage.sql, moduleId, roundIds);
    const hashes = new Map<string, string>();
    await Promise.all(refundRequests.map(async (refund) => {
      hashes.set(refund.operationId, await pointPayloadHash({
        moduleId,
        operationId: refund.operationId,
        kind: "refund",
        movements: refund.movements,
        result: refund.result,
      }));
    }));
    const cancelled = this.ctx.storage.transactionSync(() => {
      const count = cancelPointRoundsSync(
        this.ctx.storage.sql,
        moduleId,
        new Date().toISOString(),
        (value) => {
          if (typeof value !== "object" || value === null || !("operationId" in value) || typeof value.operationId !== "string") {
            throw new Error("invalid_refund");
          }
          const hash = hashes.get(value.operationId);
          if (hash === undefined) throw new Error("refund_retry_required");
          return hash;
        },
        roundIds,
        expectedGateRevision,
        undefined,
        MODULES.find((module) => module.id === moduleId)?.pointRoundCancellationNotice !== false,
      );
      if (count > 0) {
        for (const roundId of roundIds) {
          if (pointRoundRow(this.ctx.storage.sql, roundId)?.prepare_state === "pending") {
            this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), Date.now());
          } else this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
        }
      }
      if (expectedGateRevision !== undefined) this.ensurePointCancellationNoticeAlarmsSync();
      return count;
    });
    if (roundIds.length > 0) await this.scheduleEarliestAlarm();
    if (expectedGateRevision !== undefined && flushCancellationNotices) await this.flushPointCancellationNotices();
    return cancelled;
  }

  public async setGameModuleGate(
    moduleId: string,
    closed: boolean,
    revision: number,
    lastDisabledRevision: number | null = null,
  ): Promise<{ applied: boolean }> {
    await this.ensurePointRoundRecovery();
    return await this.setGameModuleGateInternal(moduleId, closed, revision, true, lastDisabledRevision);
  }

  private async setGameModuleGateInternal(
    moduleId: string,
    closed: boolean,
    revision: number,
    flushCancellationNotices: boolean,
    lastDisabledRevision: number | null = null,
  ): Promise<{ applied: boolean }> {
    await this.ensurePointsInitialized();
    if (lastDisabledRevision !== null && (!Number.isSafeInteger(lastDisabledRevision) || lastDisabledRevision < 1)) {
      throw new Error("invalid_revision");
    }
    const cancellation = closed
      ? undefined
      : pendingPointRoundCancellations(this.ctx.storage.sql).find((entry) => entry.moduleId === moduleId);
    const cancellationRevision = !closed
      ? Math.max(lastDisabledRevision ?? 0, cancellation?.revision ?? 0) || null
      : null;
    const roundIds = cancellationRevision === null
      ? []
      : this.ctx.storage.sql.exec<{ round_id: string }>(
        `SELECT round_id FROM game_rounds
          WHERE module_id = ? AND gate_revision < ? AND state IN ('announcing', 'open', 'resolving')
          ORDER BY created_at, round_id`,
        moduleId,
        cancellationRevision,
      ).toArray().map(({ round_id }) => round_id);
    const refundRequests = pointRoundRefundRequests(this.ctx.storage.sql, moduleId, roundIds);
    const hashes = new Map<string, string>();
    await Promise.all(refundRequests.map(async (refund) => {
      hashes.set(refund.operationId, await pointPayloadHash({
        moduleId,
        operationId: refund.operationId,
        kind: "refund",
        movements: refund.movements,
        result: refund.result,
      }));
    }));
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync(() => {
      const applied = setGameModuleGateSync(this.ctx.storage.sql, moduleId, closed, revision, (value) => {
        if (typeof value !== "object" || value === null || !("operationId" in value) || typeof value.operationId !== "string") {
          throw new Error("invalid_refund");
        }
        const hash = hashes.get(value.operationId);
        if (hash === undefined) throw new Error("refund_retry_required");
        return hash;
      }, now, lastDisabledRevision, (roundId) => {
        if (pointRoundRow(this.ctx.storage.sql, roundId)?.prepare_state === "pending") {
          this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), Date.now());
        } else this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
      }, (roundId) => {
        this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
      }, MODULES.find((module) => module.id === moduleId)?.pointRoundCancellationNotice !== false);
      if (!closed && cancellationRevision !== null) this.ensurePointCancellationNoticeAlarmsSync();
      return applied;
    });
    await this.scheduleEarliestAlarm();
    if (!closed && (result.applied || cancellationRevision !== null)) {
      if (flushCancellationNotices && cancellationRevision !== null) await this.flushPointCancellationNotices();
    }
    return result;
  }

  private async flushPointCancellationNotices(): Promise<void> {
    await this.ensurePointsInitialized();
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    const notices = pendingPointRoundCancellationNotices(this.ctx.storage.sql);
    for (const notice of notices) {
      const key = pointCancellationNoticeAlarmKey(notice.moduleId, notice.revision);
      if (MODULES.find((module) => module.id === notice.moduleId)?.pointRoundCancellationNotice === false) {
        this.ctx.storage.transactionSync(() => {
          completePointRoundCancellationNoticeSync(
            this.ctx.storage.sql,
            notice.moduleId,
            notice.revision,
            new Date().toISOString(),
          );
          this.clearPointRoundAlarmSync(key);
        });
        continue;
      }
      const sendOccurrenceKey = `points:cancellation:${notice.moduleId}:${String(notice.revision)}`;
      try {
        const channel = await this.env.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
          .bind(channelId).first<{ language: string }>();
        const text = templateLanguageText[channel?.language === "en" ? "en" : "de"].pointRoundCancelled;
        const result = await sendChatMessage(
          this.env,
          channelId,
          text,
          undefined,
          fetch,
          async () => {
            const state = await readDispatchChannelState(this.env.DB, channelId, new Date().toISOString());
            return chatOutputSuppressionReason({
              moduleEnabled: true,
              mandatory: false,
              paused: state.controls.pause.active,
              muted: state.controls.mute.active,
            }) === null;
          },
          async () => await claimModuleAlarmSend(
            this.ctx.storage,
            sendOccurrenceKey,
            Date.now(),
          ),
          [],
          async (delivery) => {
            if (delivery !== "not_attempted") {
              await finishModuleAlarmSend(
                this.ctx.storage,
                sendOccurrenceKey,
                delivery,
                Date.now(),
              );
            }
          },
          await readChannelDefaultChatTarget(this.env.DB, channelId),
          undefined,
          (senderId, messageText) => this.recordBotChatMessage(senderId, messageText),
        );
        const existingSend = result.reason === "already_attempted"
          ? await readModuleAlarmSendClaim(this.ctx.storage, sendOccurrenceKey)
          : null;
        const ambiguousSendTimedOut = existingSend?.status === "sending" &&
          Date.now() - existingSend.at >= POINTS_ANNOUNCE_AMBIGUOUS_MS;
        if (result.sent || (result.delivery === "ambiguous" && result.reason !== "already_attempted") ||
            existingSend?.status === "sent" || ambiguousSendTimedOut) {
          this.ctx.storage.transactionSync(() => {
            completePointRoundCancellationNoticeSync(
              this.ctx.storage.sql,
              notice.moduleId,
              notice.revision,
              new Date().toISOString(),
            );
            this.clearPointRoundAlarmSync(key);
          });
        } else {
          await this.scheduleAlarmEntry(key, POINTS_CANCELLATION_NOTICE_ALARM_HANDLER, Date.now() + POINTS_ANNOUNCE_RETRY_MS);
        }
      } catch {
        await this.scheduleAlarmEntry(key, POINTS_CANCELLATION_NOTICE_ALARM_HANDLER, Date.now() + POINTS_ANNOUNCE_RETRY_MS);
      }
    }
    await this.scheduleEarliestAlarm();
  }

  /** Runs one registered module alarm from an authorized host request. */
  public async runModuleAlarm(
    moduleId: string,
    handlerKey: string,
    alarmKey: string,
    invocation?: unknown,
  ): Promise<unknown> {
    await this.ensurePointRoundRecovery();
    const module = MODULES.find((candidate) => candidate.id === moduleId);
    const registration = module?.alarms?.find((candidate) => candidate.key === handlerKey);
    if (registration === undefined || alarmKey.length === 0 || alarmKey.length > 256) {
      throw new Error("Module alarm is unavailable.");
    }
    const execute = () => registration.handle(
      this.moduleAlarmContext(moduleId, registration, createModuleExternalFetchBudget()),
      alarmKey,
      Date.now(),
      undefined,
      invocation,
    );
    return await withCommittedPanelResourceDrain(
      () => this.runModuleAlarmHandler(moduleId, handlerKey, execute),
      () => this.notifyCommittedPanelResources(),
    );
  }

  private async recordPointRoundAnnouncement(
    roundId: string,
    state: "rate_limited" | "failed" | "delivered" | "ambiguous",
    deliveredAt: number,
  ): Promise<void> {
    const recorded = this.ctx.storage.transactionSync(() => {
      const outcome = recordPointAnnouncementSync(
        this.ctx.storage.sql,
        roundId,
        state,
        deliveredAt,
      );
      if (outcome === null) return null;
      if (outcome.cancelled) this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), deliveredAt);
      else if (state === "rate_limited") this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), deliveredAt + POINTS_ANNOUNCE_RETRY_MS);
      else if (outcome.deadlineAt !== null) this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), outcome.deadlineAt);
      return outcome;
    });
    if (recorded?.cancelled === true) await this.cancelPointRounds(recorded.moduleId, [roundId]);
    else await this.scheduleEarliestAlarm();
  }

  private appendPointRoundWelcome(
    action: Extract<ModuleAction, { kind: "chat" }>,
    module: BotModule | undefined,
    roundId: string,
    data: unknown,
    attributions?: readonly string[],
  ): Extract<ModuleAction, { kind: "chat" }> {
    if (module === undefined || !isRecord(data)) return action;
    const note = data[POINT_WELCOME_ROUND_DATA_KEY];
    if (!isRecord(note) || typeof note.accountId !== "string" || typeof note.messageId !== "string" ||
        typeof note.text !== "string") return action;
    const pending: PendingPointWelcome = {
      accountId: note.accountId,
      messageId: note.messageId,
      text: note.text,
      access: { ackWelcome: (accountId) => this.acknowledgePointWelcome("points", accountId, roundId) },
      used: false,
    };
    return appendPointWelcome(action, module, pending, attributions) as Extract<ModuleAction, { kind: "chat" }>;
  }

  private async reportPointRoundWelcomeDelivery(
    action: Extract<ModuleAction, { kind: "chat" }>,
    delivery: ModuleChatDelivery,
  ): Promise<void> {
    try {
      await action.onDelivery?.(delivery);
    } catch (error) {
      console.error("Point welcome acknowledgement failed after a game message send.", error);
    }
  }

  private async acknowledgeConfirmedPointRoundWelcome(roundId: string, phase: "announce" | "resolve"): Promise<void> {
    try {
      const round = pointRoundRow(this.ctx.storage.sql, roundId);
      if (round === null) return;
      const module = MODULES.find((candidate) => candidate.id === round.module_id);
      if (module === undefined) return;
      const registration = module.alarms?.[0] ?? POINTS_ANNOUNCEMENT_REGISTRATION;
      const context = this.moduleAlarmContext(round.module_id, registration, createModuleExternalFetchBudget());
      if (phase === "announce") {
        const formatter = module.formatPointRoundAnnouncement;
        if (formatter === undefined) return;
        const formatted = await formatter(context, {
          roundId,
          data: JSON.parse(round.data_json) as unknown,
          text: round.announce_text,
        });
        if (formatted === null || formatted.kind === "silent") return;
        const action = this.appendPointRoundWelcome({
          kind: "chat",
          text: formatted.text,
          ...(formatted.target === undefined ? {} : { target: formatted.target }),
          ...(formatted.replyToMessageId === undefined ? {} : { replyToMessageId: formatted.replyToMessageId }),
          ...(formatted.automated === undefined ? {} : { automated: formatted.automated }),
        }, module, roundId, JSON.parse(round.data_json) as unknown, formatted.attributions);
        await this.reportPointRoundWelcomeDelivery(action, "sent");
        return;
      }
      const formatter = module.formatPointRoundResult;
      if (formatter === undefined || round.state !== "resolved") return;
      const operation = this.ctx.storage.sql.exec<{ result_json: string }>(
        "SELECT result_json FROM point_operations WHERE operation_id = ? AND module_id = ?",
        `round:${roundId}:resolve`,
        round.module_id,
      ).toArray()[0];
      if (operation === undefined) return;
      const formatted = await formatter(context, {
        roundId,
        data: JSON.parse(round.data_json) as unknown,
        result: JSON.parse(operation.result_json) as unknown,
        resolvedAt: round.resolved_at ?? new Date().toISOString(),
      });
      if (formatted === null) return;
      const action = this.appendPointRoundWelcome({
        kind: "chat",
        text: formatted.text,
        ...(formatted.target === undefined ? {} : { target: formatted.target }),
        ...(formatted.replyToMessageId === undefined ? {} : { replyToMessageId: formatted.replyToMessageId }),
        ...(formatted.automated === undefined ? {} : { automated: formatted.automated }),
      }, module, roundId, JSON.parse(round.data_json) as unknown, formatted.attributions);
      await this.reportPointRoundWelcomeDelivery(action, "sent");
    } catch (error) {
      console.error(`Confirmed point round ${roundId} send could not acknowledge its welcome.`, error);
    }
  }

  private async handlePointRoundAlarm(alarmKey: string, now: number): Promise<void> {
    await this.ensurePointsInitialized();
    for (const cancellation of pendingPointRoundCancellations(this.ctx.storage.sql)) {
      await this.cancelOpenGameRounds(cancellation.moduleId, cancellation.revision);
    }
    const roundId = alarmKey.startsWith(POINTS_ROUND_ALARM_PREFIX)
      ? alarmKey.slice(POINTS_ROUND_ALARM_PREFIX.length)
      : "";
    if (roundId.length === 0) return;
    let round = pointRoundRow(this.ctx.storage.sql, roundId);
    if (round === null) return;
    if (round.prepare_state === "pending") {
      const pendingRound = round;
      const module = MODULES.find((candidate) => candidate.id === pendingRound.module_id);
      const prepare = module?.onPointRoundOpened;
      if (module !== undefined && prepare !== undefined) {
        await this.runModuleAlarmHandler(module.id, POINTS_ANNOUNCEMENT_REGISTRATION.key, () => prepare(
          this.moduleAlarmContext(pendingRound.module_id, POINTS_ANNOUNCEMENT_REGISTRATION, createModuleExternalFetchBudget()),
          { roundId, data: JSON.parse(pendingRound.data_json) as unknown, text: pendingRound.announce_text },
        ));
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE game_rounds SET prepare_state = 'delivered' WHERE round_id = ?", roundId);
      });
    }
    await this.reconcilePointModuleActivation(round.module_id, true);
    round = pointRoundRow(this.ctx.storage.sql, roundId);
    if (round === null) return;
    if (round.state === "cancelled") {
      this.ctx.storage.transactionSync(() => { this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId)); });
      await this.scheduleEarliestAlarm();
      return;
    }
    if (round.state === "resolved") {
      if (round.resolve_delivery_state === "pending" || round.resolve_delivery_state === "sending") {
        await this.deliverPointRoundResult(roundId);
      } else this.ctx.storage.transactionSync(() => { this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId)); });
      return;
    }
    if (round.state === "open") {
      if (round.deadline_at === null || round.deadline_at > now) return;
      const settlement = settlementFromRoundData(JSON.parse(round.data_json) as unknown);
      if (settlement === null) {
        console.error(`Point round ${roundId} has no persisted settlement.`);
        await this.cancelPointRounds(round.module_id, [roundId]);
        return;
      }
      try {
        await this.resolveGameRound(round.module_id, roundId, settlement);
      } catch (error) {
        if (error instanceof Error && error.message === "round_cancelled") return;
        const current = pointRoundRow(this.ctx.storage.sql, roundId);
        if (error instanceof Error && error.message === "operation_conflict" && current?.state === "resolved") {
          if (current.resolve_delivery_state === "pending" || current.resolve_delivery_state === "sending") {
            await this.deliverPointRoundResult(roundId);
          }
          return;
        }
        throw error;
      }
      await this.deliverPointRoundResult(roundId);
      return;
    }
    if (round.announce_state === "failed") {
      await this.cancelPointRounds(round.module_id, [roundId]);
      return;
    }
    if (round.announce_state === "rate_limited" && round.announce_attempts >= POINTS_ANNOUNCE_MAX_ATTEMPTS) {
      await this.recordPointRoundAnnouncement(roundId, "failed", now);
      return;
    }
    if (round.announce_state === "pending" && round.announce_attempts > 0 && round.last_attempt_at !== null) {
      const sendClaim = await readModuleAlarmSendClaim(this.ctx.storage, `round:${roundId}:announce`);
      if (sendClaim?.status === "sent") {
        await this.acknowledgeConfirmedPointRoundWelcome(roundId, "announce");
        await this.recordPointRoundAnnouncement(roundId, "delivered", sendClaim.at);
        return;
      }
      if (sendClaim !== null && sendClaim.at !== round.last_attempt_at) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("UPDATE game_rounds SET last_attempt_at = ? WHERE round_id = ? AND state = 'announcing'", sendClaim.at, roundId);
        });
        round = pointRoundRow(this.ctx.storage.sql, roundId);
        if (round === null) return;
      }
      if (sendClaim === null) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "UPDATE game_rounds SET announce_state = 'rate_limited', announce_attempts = announce_attempts - 1, last_attempt_at = NULL WHERE round_id = ? AND state = 'announcing'",
            roundId,
          );
        });
        round = pointRoundRow(this.ctx.storage.sql, roundId);
        if (round === null) return;
      }
    }
    const context = this.moduleAlarmContext(
      round.module_id,
      POINTS_ANNOUNCEMENT_REGISTRATION,
      createModuleExternalFetchBudget(),
    );
    const module = MODULES.find((candidate) => candidate.id === round.module_id);
    const formatAnnouncement = module?.formatPointRoundAnnouncement;
    const announcement: ModulePointRoundAnnouncement = {
      roundId,
      data: JSON.parse(round.data_json) as unknown,
      text: round.announce_text,
    };
    // Preparation has no chat side effect. Persist a send attempt only after it succeeds.
    const pendingSend = round.announce_state === "pending" && round.announce_attempts > 0 && round.last_attempt_at !== null;
    const formatted = pendingSend || formatAnnouncement === undefined ? null : await formatAnnouncement(context, announcement);
    const attemptAt = Date.now();
    const attempt = this.ctx.storage.transactionSync(() => {
      const claimed = announceAttemptSync(this.ctx.storage.sql, roundId, attemptAt);
      if (claimed.outcome === "attempt") {
        this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), attemptAt + POINTS_ANNOUNCE_RETRY_MS);
      }
      return claimed;
    });
    if (attempt.outcome === "ambiguous") {
      await this.recordPointRoundAnnouncement(roundId, "ambiguous", attempt.round?.last_attempt_at ?? now);
      return;
    }
    if (attempt.outcome === "pending") {
      const retryAt = (attempt.round?.last_attempt_at ?? now) + POINTS_ANNOUNCE_AMBIGUOUS_MS;
      this.ctx.storage.transactionSync(() => {
        this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), retryAt);
      });
      await this.scheduleEarliestAlarm();
      return;
    }
    if (attempt.outcome !== "attempt" || attempt.round === null || attempt.attempt === null) {
      await this.scheduleEarliestAlarm();
      return;
    }
    const attemptRound = attempt.round;
    const attemptNumber = attempt.attempt;
    await this.scheduleEarliestAlarm();
    const roundData = JSON.parse(attemptRound.data_json) as unknown;
    if (formatted?.kind === "silent" || (typeof roundData === "object" && roundData !== null && !Array.isArray(roundData) &&
        Reflect.get(roundData, "silentAnnouncement") === true)) {
      await this.recordPointRoundAnnouncement(roundId, "delivered", Date.now());
      return;
    }
    const attemptTimestamp = attemptRound.last_attempt_at;
    const stillValid = async (): Promise<boolean> => {
      await this.reconcilePointModuleActivation(attemptRound.module_id, true);
      const current = pointRoundRow(this.ctx.storage.sql, roundId);
      return current !== null && current.state === "announcing" && current.announce_state === "pending" &&
        current.announce_attempts === attemptNumber && current.last_attempt_at === attemptTimestamp;
    };
    const action = this.appendPointRoundWelcome({
      kind: "chat",
      text: formatted?.text ?? attemptRound.announce_text,
      ...(formatted?.target === undefined ? {} : { target: formatted.target }),
      ...(formatted?.replyToMessageId === undefined ? {} : { replyToMessageId: formatted.replyToMessageId }),
      ...(formatted?.automated === undefined ? {} : { automated: formatted.automated }),
    }, module, roundId, roundData, formatted?.attributions);
    const delivery = await context.sendChat(
      action.text,
      `round:${roundId}:announce`,
      formatted?.attributions,
      stillValid,
      action.target,
      {
        ...(action.replyToMessageId === undefined ? {} : { replyToMessageId: action.replyToMessageId }),
        ...(formatted?.sourceBroadcasterUserId === undefined ? {} : { sourceBroadcasterUserId: formatted.sourceBroadcasterUserId }),
        ...(action.automated === undefined ? {} : { automated: action.automated }),
      },
    );
    await this.reportPointRoundWelcomeDelivery(action, pointWelcomeDelivery(delivery));
    const sendReturnedAt = Date.now();
    await this.recordPointRoundAnnouncement(
      roundId,
      pointRoundDeliveryOutcome(delivery),
      delivery.delivery === "ambiguous" ? delivery.attemptedAt ?? attemptAt : sendReturnedAt,
    );
  }

  private async deliverPointRoundResult(roundId: string): Promise<void> {
    const initialRound = pointRoundRow(this.ctx.storage.sql, roundId);
    if (initialRound?.state === "resolved") await this.notifyPointRoundResolved(roundId);
    const initialModule = MODULES.find((candidate) => candidate.id === initialRound?.module_id);
    const retryRateLimited = initialModule?.retryPointRoundRateLimitedResults === true;
    if (initialRound?.state === "resolved" && initialRound.resolve_delivery_state === "sending") {
      const claim = await readModuleAlarmSendClaim(this.ctx.storage, `round:${roundId}:resolve`);
      const now = Date.now();
      if (claim !== null) {
        if (claim.status === "sent" || now - claim.at >= POINTS_ANNOUNCE_AMBIGUOUS_MS) {
          if (claim.status === "sent") await this.acknowledgeConfirmedPointRoundWelcome(roundId, "resolve");
          this.ctx.storage.transactionSync(() => {
            recordPointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId, "delivered");
            this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
          });
          await this.scheduleEarliestAlarm();
          return;
        }
        this.ctx.storage.transactionSync(() => {
          if (claim.at !== initialRound.resolve_delivery_last_attempt_at) {
            this.ctx.storage.sql.exec(
              `UPDATE game_rounds SET resolve_delivery_last_attempt_at = ?
                WHERE round_id = ? AND state = 'resolved' AND resolve_delivery_state = 'sending'`,
              claim.at,
              roundId,
            );
          }
          this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), claim.at + POINTS_ANNOUNCE_AMBIGUOUS_MS);
        });
        await this.scheduleEarliestAlarm();
        return;
      }
      const retryAt = now + POINTS_ANNOUNCE_RETRY_MS;
      this.ctx.storage.transactionSync(() => {
        const state = recordPointRoundResolutionPreparationFailureSync(this.ctx.storage.sql, roundId, now);
        if (state === "pending") this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), retryAt);
        else this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
      });
      await this.scheduleEarliestAlarm();
      return;
    }

    const prepared = this.ctx.storage.transactionSync(() =>
      pointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId));
    if (prepared.outcome === "delivered" || prepared.outcome === "suppressed" || prepared.outcome === "failed" || prepared.outcome === "ignored") {
      this.ctx.storage.transactionSync(() => { this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId)); });
      await this.scheduleEarliestAlarm();
      return;
    }
    if (prepared.outcome === "pending" || prepared.round === null) {
      const retryAt = (prepared.round?.resolve_delivery_last_attempt_at ?? Date.now()) + POINTS_ANNOUNCE_AMBIGUOUS_MS;
      this.ctx.storage.transactionSync(() => { this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), retryAt); });
      await this.scheduleEarliestAlarm();
      return;
    }
    const module = MODULES.find((candidate) => candidate.id === prepared.round?.module_id);
    const formatter = module?.formatPointRoundResult;
    if (module === undefined || formatter === undefined) {
      this.ctx.storage.transactionSync(() => {
        recordPointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId, "delivered");
        this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
      });
      await this.scheduleEarliestAlarm();
      return;
    }
    const registration = module.alarms?.[0] ?? {
      key: "round-result",
      handle: () => Promise.resolve(undefined),
    };
    let context: ModuleAlarmContext;
    let formatted: Awaited<ReturnType<typeof formatter>>;
    try {
      context = this.moduleAlarmContext(
        module.id,
        registration,
        createModuleExternalFetchBudget(),
      );
      const roundData = JSON.parse(prepared.round.data_json) as unknown;
      const result: ModulePointRoundResult = {
        roundId,
        data: roundData,
        result: prepared.result,
        resolvedAt: prepared.round.resolved_at ?? new Date().toISOString(),
      };
      formatted = await formatter(context, result);
    } catch (error) {
      console.error(`Point round ${roundId} result preparation failed.`, error);
      const failedAt = Date.now();
      this.ctx.storage.transactionSync(() => {
        const state = recordPointRoundResolutionPreparationFailureSync(this.ctx.storage.sql, roundId, failedAt);
        if (state === "pending") this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), failedAt + POINTS_ANNOUNCE_RETRY_MS);
        else this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
      });
      await this.scheduleEarliestAlarm();
      return;
    }
    if (formatted === null || formatted.text.length === 0) {
      this.ctx.storage.transactionSync(() => {
        recordPointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId, "delivered");
        this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
      });
      await this.scheduleEarliestAlarm();
      return;
    }

    const attemptAt = Date.now();
    const attempt = this.ctx.storage.transactionSync(() => {
      const started = beginPointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId, attemptAt);
      if (started.outcome === "attempt") {
        this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), attemptAt + POINTS_ANNOUNCE_AMBIGUOUS_MS);
      }
      return started;
    });
    if (attempt.outcome === "delivered" || attempt.outcome === "suppressed" || attempt.outcome === "failed" || attempt.outcome === "ignored") {
      this.ctx.storage.transactionSync(() => { this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId)); });
      await this.scheduleEarliestAlarm();
      return;
    }
    if (attempt.outcome === "pending" || attempt.round === null) {
      const retryAt = (attempt.round?.resolve_delivery_last_attempt_at ?? Date.now()) + POINTS_ANNOUNCE_AMBIGUOUS_MS;
      this.ctx.storage.transactionSync(() => { this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), retryAt); });
      await this.scheduleEarliestAlarm();
      return;
    }
    const rowIsCurrent = async (): Promise<boolean> => {
      await this.reconcilePointModuleActivation(module.id, true);
      const current = pointRoundRow(this.ctx.storage.sql, roundId);
      return current !== null && current.state === "resolved" && current.resolve_delivery_state === "sending" &&
        current.resolve_delivery_attempts === attempt.round?.resolve_delivery_attempts &&
        pointRoundDeliveryGateIsCurrentSync(this.ctx.storage.sql, current);
    };
    let delivery: Awaited<ReturnType<ModuleAlarmContext["sendChat"]>>;
    try {
      await this.scheduleEarliestAlarm();
      const action = this.appendPointRoundWelcome({
        kind: "chat",
        text: formatted.text,
        ...(formatted.target === undefined ? {} : { target: formatted.target }),
        ...(formatted.replyToMessageId === undefined ? {} : { replyToMessageId: formatted.replyToMessageId }),
        ...(formatted.automated === undefined ? {} : { automated: formatted.automated }),
      }, module, roundId, JSON.parse(attempt.round.data_json) as unknown, formatted.attributions);
      delivery = await context.sendChat(
        action.text,
        `round:${roundId}:resolve`,
        formatted.attributions,
        () => Promise.resolve(rowIsCurrent()),
        action.target,
        {
          ...(action.replyToMessageId === undefined ? {} : { replyToMessageId: action.replyToMessageId }),
          ...(formatted.sourceBroadcasterUserId === undefined ? {} : { sourceBroadcasterUserId: formatted.sourceBroadcasterUserId }),
          ...(action.automated === undefined ? {} : { automated: action.automated }),
        },
      );
      await this.reportPointRoundWelcomeDelivery(action, pointWelcomeDelivery(delivery));
    } catch (error) {
      const claim = await readModuleAlarmSendClaim(this.ctx.storage, `round:${roundId}:resolve`);
      if (claim === null) {
        console.error(`Point round ${roundId} result send failed before a transport claim.`, error);
        const failedAt = Date.now();
        this.ctx.storage.transactionSync(() => {
          const state = recordPointRoundResolutionPreparationFailureSync(this.ctx.storage.sql, roundId, failedAt);
          if (state === "pending") this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), failedAt + POINTS_ANNOUNCE_RETRY_MS);
          else this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
        });
      } else if (claim.status === "sent") {
        await this.acknowledgeConfirmedPointRoundWelcome(roundId, "resolve");
        this.ctx.storage.transactionSync(() => {
          recordPointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId, "delivered");
          this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
        });
      } else {
        this.ctx.storage.transactionSync(() => {
          this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), claim.at + POINTS_ANNOUNCE_AMBIGUOUS_MS);
        });
      }
      await this.scheduleEarliestAlarm();
      return;
    }
    const permanentlySuppressed = delivery.reason === "module_disabled";
    const deliveryStatus = permanentlySuppressed ? "suppressed" : pointRoundDeliveryOutcome(delivery);
    this.ctx.storage.transactionSync(() => {
      const state = recordPointRoundResolutionDeliverySync(this.ctx.storage.sql, roundId, deliveryStatus, retryRateLimited);
      if (state === "pending") this.writePointRoundAlarmSync(pointRoundAlarmKey(roundId), Date.now() + POINTS_ANNOUNCE_RETRY_MS);
      else this.clearPointRoundAlarmSync(pointRoundAlarmKey(roundId));
    });
    await this.scheduleEarliestAlarm();
  }

  private async notifyPointRoundResolved(roundId: string): Promise<void> {
    const round = pointRoundRow(this.ctx.storage.sql, roundId);
    if (round === null || round.state !== "resolved") return;
    const module = MODULES.find((candidate) => candidate.id === round.module_id);
    const onResolved = module?.onPointRoundResolved;
    if (module === undefined || onResolved === undefined) return;
    const operation = this.ctx.storage.sql.exec<{ result_json: string }>(
      "SELECT result_json FROM point_operations WHERE operation_id = ? AND module_id = ?",
      `round:${roundId}:resolve`,
      round.module_id,
    ).toArray()[0];
    if (operation === undefined) return;
    const notification: ModulePointRoundResult = {
      roundId,
      data: JSON.parse(round.data_json) as unknown,
      result: JSON.parse(operation.result_json) as unknown,
      resolvedAt: round.resolved_at ?? new Date().toISOString(),
    };
    const registration = module.alarms?.[0] ?? POINTS_ANNOUNCEMENT_REGISTRATION;
    await this.runModuleAlarmHandler(module.id, registration.key, () => onResolved(
      this.moduleAlarmContext(module.id, registration, createModuleExternalFetchBudget()),
      notification,
    ));
  }

  private ballotAccess(moduleId: string): ModuleBallotAccess {
    return {
      open: (ballotId, optionCount, expiresAt, rule, termFilter) => this.openBallot(moduleId, ballotId, optionCount, expiresAt, rule, termFilter),
      cast: (ballotId, userId, choice, options) => this.castBallot(moduleId, ballotId, userId, choice, options),
      castTerm: (ballotId, userId, term, matchText) => this.castBallotTerm(moduleId, ballotId, userId, term, matchText),
      setBlockedTerms: (ballotId, terms) => setStoredBallotBlockedTerms(this.ballotStorage(moduleId), moduleId, ballotId, terms),
      approveTerm: (ballotId, term) => approveStoredBallotTerm(this.ballotStorage(moduleId), moduleId, ballotId, term),
      read: (ballotId) => this.readBallot(moduleId, ballotId),
      close: (ballotId) => this.closeBallot(moduleId, ballotId),
      finalize: (ballotId) => this.finalizeBallot(moduleId, ballotId),
      acknowledgeClosed: (ballotId) => this.acknowledgeClosedBallot(moduleId, ballotId),
    };
  }

  /** Opens a channel-wide exclusive ballot for a host-supplied module id. */
  public async openBallot(
    moduleId: string,
    ballotId: string,
    optionCount: number,
    expiresAt: number,
    passRule?: BallotFinalizeRule,
    termFilter?: BallotTermFilter,
  ): Promise<BallotOpenResult> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Ballots require a named Durable Object.");
    const requestedAlarmKey = ballotExpiryAlarmKey(moduleId, ballotId);
    const result = await openStoredBallot(
      this.ballotStorage(moduleId),
      moduleId,
      ballotId,
      optionCount,
      expiresAt,
      passRule,
      async (transaction) => {
        await this.writeBallotAlarmInTransaction(
          transaction, requestedAlarmKey, BALLOT_EXPIRY_ALARM_HANDLER, expiresAt,
        );
      },
      async (transaction, finalizedModuleId, finalizedBallotId, hardDeleteAt) => {
        await this.writeBallotAlarmInTransaction(
          transaction,
          ballotExpiryAlarmKey(finalizedModuleId, finalizedBallotId),
          BALLOT_HARD_DELETE_ALARM_HANDLER,
          hardDeleteAt,
        );
      },
      termFilter,
    );
    if (result.status === "opened" || result.activeBallot !== undefined) {
      await this.notifyCommittedPanelResources();
    }
    if (result.status === "opened") {
      return { status: "opened" };
    }
    return { status: "busy", moduleId: result.moduleId };
  }

  public async castBallot(
    moduleId: string,
    ballotId: string,
    userId: string,
    choice: number,
    options?: { onlyIfNew?: boolean },
  ): Promise<BallotCastResult> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null) return { status: "not_open", counts: [], revision: 0 };
    const result = await castStoredBallot(this.ballotStorage(moduleId), channelId, moduleId, ballotId, userId, choice, options);
    if (result.status === "counted" || result.status === "changed") {
      await this.notifyCommittedPanelResources();
    }
    return result;
  }

  public async castBallotTerm(
    moduleId: string,
    ballotId: string,
    userId: string,
    term: string,
    matchText?: string,
  ): Promise<BallotCastResult> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null) return { status: "not_open", counts: [], revision: 0 };
    const result = await castStoredBallotTerm(this.ballotStorage(moduleId), channelId, moduleId, ballotId, userId, term, matchText);
    if (result.status === "counted" || result.status === "changed" || result.status === "overflow") {
      await this.notifyCommittedPanelResources();
    }
    return result;
  }

  public async setBlockedTerms(
    moduleId: string,
    ballotId: string,
    blockedTerms: readonly string[],
  ): Promise<BallotSnapshot | null> {
    await this.ensurePointRoundRecovery();
    const snapshot = await setStoredBallotBlockedTerms(this.ballotStorage(moduleId), moduleId, ballotId, blockedTerms);
    if (snapshot !== null) await this.notifyCommittedPanelResources();
    return snapshot;
  }

  public async approveTerm(
    moduleId: string,
    ballotId: string,
    term: string,
  ): ReturnType<typeof approveStoredBallotTerm> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null || moduleId !== CHAT_VOTING_MODULE_ID) {
      return { status: "not_open", snapshot: null };
    }
    const approval = await this.env.DB.prepare(
      `SELECT 1 AS approved
         FROM chat_vote_term_approvals
        WHERE channel_id = ? AND poll_id = ? AND term = ?`,
    ).bind(channelId, ballotId, term).first<{ approved: number }>();
    if (approval === null) return { status: "not_open", snapshot: null };
    const result = await approveStoredBallotTerm(this.ballotStorage(moduleId), moduleId, ballotId, term);
    if (result.status === "approved" && result.snapshot !== null) {
      await this.notifyCommittedPanelResources();
    }
    return result;
  }

  public async readBallot(moduleId: string, ballotId: string): Promise<BallotSnapshot | null> {
    await this.ensurePointRoundRecovery();
    const snapshot = await readStoredBallot(this.ballotStorage(moduleId), moduleId, ballotId, async (transaction, finalizedModuleId, finalizedBallotId, hardDeleteAt) => {
      await this.writeBallotAlarmInTransaction(
        transaction,
        ballotExpiryAlarmKey(finalizedModuleId, finalizedBallotId),
        BALLOT_HARD_DELETE_ALARM_HANDLER,
        hardDeleteAt,
      );
    });
    if (snapshot?.outcome !== undefined) {
      await this.notifyCommittedPanelResources();
    }
    return snapshot;
  }

  public async readBallotSnapshot(moduleId: string, ballotId: string): Promise<BallotSnapshot | null> {
    return await readStoredBallotSnapshot(this.ballotStorage(moduleId), moduleId, ballotId);
  }

  public async readBallotDryRunSnapshot(
    moduleId: string,
    ballotId: string,
    voterId?: string,
  ): Promise<ModuleDryRunBallotSnapshot | null> {
    return await readStoredBallotDryRunSnapshot(
      this.ballotStorage(moduleId), moduleId, ballotId, this.ownChannelId() ?? undefined, voterId,
    );
  }

  public async hasOpenBallot(): Promise<boolean> {
    await this.ensurePointRoundRecovery();
    const hasOpen = await hasOpenStoredBallot(this.ballotStorage(CHAT_VOTING_MODULE_ID), async (transaction, moduleId, ballotId, hardDeleteAt) => {
      await this.writeBallotAlarmInTransaction(
        transaction,
        ballotExpiryAlarmKey(moduleId, ballotId),
        BALLOT_HARD_DELETE_ALARM_HANDLER,
        hardDeleteAt,
      );
    });
    if (!hasOpen) await this.notifyCommittedPanelResources();
    return hasOpen;
  }

  public async hasOpenBallotSnapshot(): Promise<boolean> {
    return await hasOpenStoredBallotSnapshot(this.ballotStorage(CHAT_VOTING_MODULE_ID));
  }

  public async closeBallot(moduleId: string, ballotId: string): Promise<BallotSnapshot | null> {
    await this.ensurePointRoundRecovery();
    const result = await closeStoredBallot(this.ballotStorage(moduleId), moduleId, ballotId);
    if (result !== null) await this.notifyCommittedPanelResources();
    await this.clearAlarmEntry(ballotExpiryAlarmKey(moduleId, ballotId));
    return result;
  }

  public async finalizeBallot(moduleId: string, ballotId: string): Promise<BallotFinalizeResult> {
    await this.ensurePointRoundRecovery();
    const result = await finalizeStoredBallot(this.ballotStorage(moduleId), moduleId, ballotId, async (transaction, finalizedModuleId, finalizedBallotId, hardDeleteAt) => {
      await this.writeBallotAlarmInTransaction(
        transaction,
        ballotExpiryAlarmKey(finalizedModuleId, finalizedBallotId),
        BALLOT_HARD_DELETE_ALARM_HANDLER,
        hardDeleteAt,
      );
    });
    if (result.outcome !== "not_open" && result.outcome !== "open") {
      await this.notifyCommittedPanelResources();
    }
    return result;
  }

  public async acknowledgeClosedBallot(moduleId: string, ballotId: string): Promise<void> {
    await this.ensurePointRoundRecovery();
    await forgetClosedStoredBallot(this.ctx.storage, moduleId, ballotId);
  }

  private async expireBallot(key: string): Promise<void> {
    const identity = ballotIdentityFromExpiryAlarmKey(key);
    if (identity === null) return;
    const nextExpiry = await expireStoredBallot(
      this.ballotStorage(identity.moduleId),
      identity.moduleId,
      identity.ballotId,
      async (transaction, moduleId, ballotId, hardDeleteAt) => {
        await this.writeBallotAlarmInTransaction(
          transaction, ballotExpiryAlarmKey(moduleId, ballotId), BALLOT_HARD_DELETE_ALARM_HANDLER, hardDeleteAt,
        );
      },
    );
    if (nextExpiry === null) await this.notifyCommittedPanelResources();
    if (nextExpiry !== null) {
      await this.scheduleAlarmEntry(key, BALLOT_EXPIRY_ALARM_HANDLER, nextExpiry);
    }
  }

  private async hardDeleteBallot(key: string): Promise<void> {
    const identity = ballotIdentityFromExpiryAlarmKey(key);
    if (identity === null) return;
    const retryAt = await hardDeleteFinalizedStoredBallot(this.ballotStorage(identity.moduleId), identity.moduleId, identity.ballotId);
    if (retryAt !== null) await this.scheduleAlarmEntry(key, BALLOT_HARD_DELETE_ALARM_HANDLER, retryAt);
  }

  private ballotPanelResources(moduleId: string): string[] {
    return [...new Set([`module:${moduleId}:panel`, "module:chat_voting:panel"])];
  }

  /** Wraps ballot storage transactions so the vector commits with ballot state. */
  private ballotStorage(moduleId: string): Pick<DurableObjectStorage, "get" | "list" | "put" | "delete" | "transaction"> {
    const storage = this.ctx.storage;
    const transaction = <Value>(
      operation: (transaction: DurableObjectTransaction) => Promise<Value>,
    ): Promise<Value> => storage.transaction(async (underlying) => {
      const changedResources = new Set<string>();
      const recordWrite = (keyArgument: unknown): void => {
        const keys = typeof keyArgument === "string" ? [keyArgument]
          : Array.isArray(keyArgument) ? keyArgument.filter((key): key is string => typeof key === "string")
            : typeof keyArgument === "object" && keyArgument !== null ? Object.keys(keyArgument) : [];
        for (const key of keys) {
          if (key === "ballot:active") {
            this.ballotPanelResources(moduleId).forEach((resource) => changedResources.add(resource));
            continue;
          }
          const match = /^ballot:(?:closed:)?([A-Za-z0-9_-]{1,128}):/u.exec(key);
          if (match?.[1] !== undefined) this.ballotPanelResources(match[1]).forEach((resource) => changedResources.add(resource));
        }
      };
      const monitored = new Proxy(underlying, {
        get: (target, property, receiver) => {
          if (property === "put" || property === "delete") {
            const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
            return (...args: unknown[]): unknown => {
              recordWrite(args[0]);
              return Reflect.apply(method, target, args);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) as unknown : value;
        },
      });
      const result = await operation(monitored);
      if (changedResources.size > 0) await bumpDurablePanelResources(underlying, [...changedResources]);
      return result;
    });
    return {
      get: storage.get.bind(storage),
      list: storage.list.bind(storage),
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      transaction,
    };
  }

  private async notifyCommittedPanelResources(): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    await notifyCommittedResources(this.env, channelId, (revisions) => this.reconcilePanelResources(revisions));
  }

  public async getPanelResourceRevisions(): Promise<PanelResourceRevisionVector> {
    await this.ensurePointRoundRecovery();
    return await this.ctx.storage.get<PanelResourceRevisionVector>(PANEL_DURABLE_REVISIONS_KEY) ?? {};
  }

  /** Delivers only advanced, data-free resources to panel principals in this channel. */
  public async reconcilePanelResources(revisions: PanelResourceRevisionVector): Promise<void> {
    await this.ensurePointRoundRecovery();
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    const durableRevisions = await this.getPanelResourceRevisions();
    const combinedRevisions = { ...revisions };
    for (const [resource, revision] of Object.entries(durableRevisions)) {
      combinedRevisions[resource] = (combinedRevisions[resource] ?? 0) + revision;
    }
    const channelRevisionTotal = Object.entries(combinedRevisions)
      .filter(([resource]) => resource !== "channel.all")
      .reduce((sum, [, revision]) => Math.min(Number.MAX_SAFE_INTEGER, sum + revision), 0);
    const previous = await this.ctx.storage.get<PanelResourceRevisionVector>(PANEL_PUBLISHED_REVISIONS_KEY) ?? {};
    const advanced = Object.entries(combinedRevisions)
      .filter(([resource, revision]) => revision > (previous[resource] ?? 0))
      .sort(([left], [right]) => left.localeCompare(right));
    if (advanced.length === 0) return;
    const next = Object.fromEntries(advanced);
    const overflow = advanced.length > 128;
    // Large batches carry one bounded wake-up hint; the authenticated GET
    // still returns the exact per-resource vector for client invalidation.
    const resources = overflow ? ["channel.all"] : advanced.map(([resource]) => resource);
    const messageRevisions = overflow
      ? { "channel.all": channelRevisionTotal }
      : next;
    const message = panelResourceChangedMessage(channelId, resources, messageRevisions);
    await this.publish([message]);
    await this.ctx.storage.transaction(async (transaction) => {
      const latest = await transaction.get<PanelResourceRevisionVector>(PANEL_PUBLISHED_REVISIONS_KEY) ?? {};
      const published = { ...latest };
      for (const [resource, revision] of Object.entries(combinedRevisions)) {
        published[resource] = Math.max(published[resource] ?? 0, revision);
      }
      await transaction.put(PANEL_PUBLISHED_REVISIONS_KEY, published);
    });
  }

  private async writeBallotAlarmInTransaction(
    transaction: AlarmStorageAccess & Pick<DurableObjectTransaction, "setAlarm" | "deleteAlarm">,
    key: string,
    handler: string,
    deadline: number,
  ): Promise<void> {
    const table = await readAlarmScheduleTable(transaction);
    const current = table[key];
    table[key] = { deadline, handler, revision: (current?.revision ?? 0) + 1 };
    await transaction.put(ALARM_TABLE_KEY, table);
    const nextAlarmAt = earliestAlarmAt(table, Date.now());
    if (nextAlarmAt === null) await transaction.deleteAlarm();
    else await transaction.setAlarm(nextAlarmAt);
  }

  private async pruneCompletedClipJobs(now: number, force = false): Promise<void> {
    const lastPrunedAt = await this.ctx.storage.get<number>(CLIP_JOB_LAST_PRUNED_KEY);
    if (!force && typeof lastPrunedAt === "number" && Number.isFinite(lastPrunedAt) && now - lastPrunedAt < CLIP_JOB_PRUNE_INTERVAL_MS) return;
    const jobs = await this.ctx.storage.list({ prefix: CLIP_JOB_STORAGE_PREFIX });
    const expiredKeys = [...jobs].flatMap(([key, value]) =>
      isStoredClipJob(value) && (value.status === "complete" || value.status === "failed") && typeof value.completedAt === "number" &&
      now - value.completedAt >= CLIP_JOB_COMPLETED_RETENTION_MS ? [key] : []);
    for (let offset = 0; offset < expiredKeys.length; offset += 128) {
      await this.ctx.storage.delete(expiredKeys.slice(offset, offset + 128));
    }
    await this.ctx.storage.put(CLIP_JOB_LAST_PRUNED_KEY, now);
  }

  private async nextClipJobCleanupAt(): Promise<number | null> {
    const jobs = await this.ctx.storage.list({ prefix: CLIP_JOB_STORAGE_PREFIX });
    const expiries = [...jobs.values()].flatMap((value) =>
      isStoredClipJob(value) && (value.status === "complete" || value.status === "failed") &&
      typeof value.completedAt === "number" ? [value.completedAt + CLIP_JOB_COMPLETED_RETENTION_MS] : []);
    return expiries.length === 0 ? null : Math.min(...expiries);
  }

  private async pendingClipJobs(channelId: string): Promise<StoredClipJob[]> {
    const rows = await this.ctx.storage.list({ prefix: CLIP_JOB_STORAGE_PREFIX });
    return [...rows.values()].flatMap((value) =>
      isStoredClipJob(value) && value.channelId === channelId &&
        (value.status === "pending" || value.status === "reporting_failure") ? [value] : [])
      .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.createdAt.localeCompare(right.createdAt));
  }

  private async runClipJobAlarm(now: number): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    await this.pruneCompletedClipJobs(now, true);
    const pending = await this.pendingClipJobs(channelId);
    const ready = pending.find((job) => job.nextAttemptAt <= now);
    if (ready !== undefined) await this.processClipJob(ready);

    const remaining = await this.pendingClipJobs(channelId);
    const pendingAt = remaining.length === 0 ? null : remaining.reduce((earliest, job) => Math.min(earliest, job.nextAttemptAt), Number.POSITIVE_INFINITY);
    const cleanupAt = await this.nextClipJobCleanupAt();
    const nextWakeAt = [pendingAt, cleanupAt].filter((deadline): deadline is number => deadline !== null)
      .reduce<number | null>((earliest, deadline) => earliest === null ? deadline : Math.min(earliest, deadline), null);
    if (nextWakeAt !== null) {
      await this.scheduleAlarmEntry(CLIP_JOB_ALARM_KEY, CLIP_JOB_ALARM_HANDLER, Math.max(nextWakeAt, Date.now() + 1));
    }
  }

  private async completeClipJob(job: StoredClipJob): Promise<void> {
    const completedAt = Date.now();
    await this.ctx.storage.put(clipJobStorageKey(job.triggerId), {
      ...job,
      status: "complete",
      nextAttemptAt: completedAt,
      completedAt,
    } satisfies StoredClipJob);
  }

  private async failClipJob(job: StoredClipJob, reason: string, attempts: number): Promise<void> {
    const now = Date.now();
    const failure = { channelId: job.channelId, triggerId: job.triggerId, reason: reason.slice(0, 160), attempts };
    const reportingJob: StoredClipJob = {
      ...job,
      attempts,
      nextAttemptAt: now,
      status: "reporting_failure",
      failure,
    };
    await this.ctx.storage.put(clipJobStorageKey(job.triggerId), reportingJob);
    await this.writeClipJobFailureDiagnostic(reportingJob);
  }

  private async retryClipJob(job: StoredClipJob, attempts: number, retryAfter: number | null = null): Promise<void> {
    const now = Date.now();
    const delay = CLIP_JOB_RETRY_DELAYS_MS[attempts - 1] ?? CLIP_JOB_RETRY_DELAYS_MS.at(-1) ?? 15_000;
    await this.ctx.storage.put(clipJobStorageKey(job.triggerId), {
      ...job,
      attempts,
      nextAttemptAt: typeof retryAfter === "number" && Number.isFinite(retryAfter)
        ? Math.max(now + delay, retryAfter)
        : now + delay,
    } satisfies StoredClipJob);
  }

  private async processClipJob(initialJob: StoredClipJob): Promise<void> {
    let job = initialJob;
    let retryAfter: number | null = null;
    if (job.status === "reporting_failure") {
      await this.writeClipJobFailureDiagnostic(job);
      return;
    }
    if (job.clipId === null && job.createAttemptedAt !== null) {
      await this.failClipJob(job, "clip_creation_outcome_uncertain", job.attempts + 1);
      return;
    }
    try {
      let confirmedClip = job.confirmedClip;
      if (confirmedClip === null) {
        let creation: ClipCreationResult;
        if (job.clipId === null) {
          const attemptedJob = { ...job, createAttemptedAt: Date.now() };
          // If the process stops after this write, recovery must not issue a second create POST.
          await this.ctx.storage.put(clipJobStorageKey(job.triggerId), attemptedJob);
          job = attemptedJob;
          creation = await requestChannelClipCreation(this.env, job.channelId);
          if (!creation.created || creation.clipId === null) {
            const attempts = job.attempts + 1;
            const reason = creation.reason ?? "clip_creation_failed";
            if (creation.delivery === "ambiguous" || creation.delivery === "accepted") {
              await this.failClipJob(job, `clip_creation_outcome_uncertain:${reason}`, attempts);
              return;
            }
            const retryable = creation.delivery === "not_attempted" || creation.detail.status === 429;
            if (retryable && attempts < CLIP_JOB_MAX_ATTEMPTS) {
              // A recorded no-attempt or definite rejection releases the POST fence for a bounded retry.
              const retryAfter = creation.detail.retryAfter;
              await this.retryClipJob(
                { ...job, createAttemptedAt: null },
                attempts,
                typeof retryAfter === "number" ? retryAfter : null,
              );
              return;
            }
            const failureReason = retryable
              ? `clip_creation_retries_exhausted:${reason}`
              : `clip_creation_rejected:${reason}`;
            await this.failClipJob(job, failureReason, attempts);
            return;
          }
          job = {
            ...job,
            clipId: creation.clipId,
            editUrl: creation.editUrl,
            creationDetail: creation.detail,
          };
          // Save Twitch's returned ID before the first availability poll. A retry can then only confirm this clip.
          await this.ctx.storage.put(clipJobStorageKey(job.triggerId), job);
        } else {
          creation = {
            created: true,
            delivery: "accepted",
            reason: null,
            detail: job.creationDetail ?? {},
            clipId: job.clipId,
            editUrl: job.editUrl,
          };
        }

        confirmedClip = await confirmChannelClipAvailability(this.env, creation);
        retryAfter = typeof confirmedClip.detail.retryAfter === "number" ? confirmedClip.detail.retryAfter : null;
        if (!confirmedClip.created || confirmedClip.clipId === null) throw new Error(confirmedClip.reason ?? "clip_confirmation_failed");
        job = { ...job, confirmedClip };
        await this.ctx.storage.put(clipJobStorageKey(job.triggerId), job);
      }

      const chatSendClaimKey = `clip:${encodeURIComponent(job.triggerId)}:chat`;
      const existingChatSend = await readModuleAlarmSendClaim(this.ctx.storage, chatSendClaimKey);
      if (existingChatSend?.status === "sent") {
        await this.completeClipJob(job);
        return;
      }

      const posted = await postConfirmedClipLink(
        this.env,
        job.channelId,
        job.actorUserId,
        job.settings,
        confirmedClip,
        fetch,
        job.triggerId,
        {
          claimBeforePost: () => claimModuleAlarmSend(this.ctx.storage, chatSendClaimKey, Date.now()),
          afterPost: async (delivery) => {
            if (delivery !== "not_attempted") {
              await finishModuleAlarmSend(this.ctx.storage, chatSendClaimKey, delivery, Date.now());
            }
          },
        },
      );
      const postFailure = posted.diagnostics.find((diagnostic) =>
        diagnostic.code === "host.chat.failed" || diagnostic.code === "host.action.failed");
      if (postFailure !== undefined) {
        retryAfter = typeof posted.retryAfter === "number" ? posted.retryAfter : null;
        throw new Error(typeof postFailure.detail?.reason === "string" ? postFailure.detail.reason : "clip_post_failed");
      }

      const completedAt = Date.now();
      await this.completeClipJob(job);
      if (posted.diagnostics.length > 0) {
        try {
          await writeModuleDiagnostics(
            this.env.DB,
            job.channelId,
            "clips",
            job.triggerId,
            job.actorUserId,
            posted.diagnostics,
            new Date(completedAt).toISOString(),
          );
        } catch (error: unknown) {
          console.error("Clip job result diagnostics could not be recorded.", error);
        }
      }
    } catch (error: unknown) {
      const reason = (error instanceof Error ? error.message : "clip_job_failed").slice(0, 160);
      const attempts = job.attempts + 1;
      if (job.clipId === null && job.createAttemptedAt !== null) {
        await this.failClipJob(job, `clip_creation_outcome_uncertain:${reason}`, attempts);
        return;
      }
      if (attempts >= CLIP_JOB_MAX_ATTEMPTS) {
        await this.failClipJob(job, reason, attempts);
        return;
      }

      await this.retryClipJob(job, attempts, retryAfter);
    }
  }

  private async writeClipJobFailureDiagnostic(job: StoredClipJob): Promise<void> {
    if (job.failure === null) return;
    const now = Date.now();
    try {
      await writeModuleDiagnostics(
        this.env.DB,
        job.channelId,
        "clips",
        job.triggerId,
        job.actorUserId,
        [{ code: "host.clip.failed", detail: { reason: job.failure.reason } }],
        new Date(now).toISOString(),
      );
      await this.ctx.storage.put(clipJobStorageKey(job.triggerId), {
        ...job,
        status: "failed",
        nextAttemptAt: now,
        completedAt: now,
      } satisfies StoredClipJob);
    } catch (error: unknown) {
      console.error("Clip job failure diagnostic could not be recorded; the alarm will retry it.", error);
      await this.ctx.storage.put(clipJobStorageKey(job.triggerId), {
        ...job,
        nextAttemptAt: now + 60_000,
      } satisfies StoredClipJob);
    }
  }

  private alarmHandlers(
    modules: readonly BotModule[] = MODULES,
    externalFetchBudget: ModuleExternalFetchBudget = createModuleExternalFetchBudget(),
  ): Map<string, AlarmHandlerRegistration> {
    const handlers = new Map<string, AlarmHandlerRegistration>([
      [ACTIVE_CHATTER_EXPIRY_HANDLER, {
        handle: async (_key, entry, now) => {
          await this.expireActiveChatters(entry.deadline, now);
        },
      }],
      [POINTS_ACTIVATION_RECONCILIATION_ALARM_HANDLER, {
        retryDelaysMs: [POINTS_ANNOUNCE_RETRY_MS],
        handle: async () => {
          await this.ensurePointsInitialized();
          await this.reconcilePointModuleActivationsDuringRecovery();
          for (const cancellation of pendingPointRoundCancellations(this.ctx.storage.sql)) {
            await this.cancelOpenGameRoundsInternal(cancellation.moduleId, cancellation.revision, false);
          }
        },
      }],
      [POINTS_ROUND_ALARM_HANDLER, {
        retryDelaysMs: [POINTS_ANNOUNCE_RETRY_MS],
        handle: async (key, _entry, now) => {
          await this.handlePointRoundAlarm(key, now);
          return undefined;
        },
      }],
      [POINTS_CANCELLATION_NOTICE_ALARM_HANDLER, {
        retryDelaysMs: [POINTS_ANNOUNCE_RETRY_MS],
        handle: async () => {
          await this.flushPointCancellationNotices();
          return undefined;
        },
      }],
      [BALLOT_EXPIRY_ALARM_HANDLER, { handle: async (key) => { await this.expireBallot(key); } }],
      [BALLOT_HARD_DELETE_ALARM_HANDLER, { handle: async (key) => { await this.hardDeleteBallot(key); } }],
      [SECURITY_ROUND_HANDLER, { handle: (_key, _entry, now, nowIso) => this.runSecurityRound(now, nowIso) }],
      [SECURITY_RETRY_HANDLER, { handle: (_key, _entry, now, nowIso) => this.runSecurityRound(now, nowIso) }],
      [AD_PREWARNING_HANDLER, {
        handle: (_key, entry, _now, nowIso) => this.runAdPrewarning(entry.deadline, nowIso),
        retryDelaysMs: AD_PREWARNING_RETRY_DELAYS_MS,
      }],
      [AD_COUNTDOWN_REFRESH_HANDLER, {
        handle: async () => {
          await this.refreshCountdownScheduleFromAlarm();
          return undefined;
        },
      }],
      [CLIP_JOB_ALARM_HANDLER, {
        handle: async (_key, _entry, now) => {
          await this.runClipJobAlarm(now);
          return undefined;
        },
      }],
      [MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER, {
        retryDelaysMs: [5_000, 15_000, 60_000],
        handle: async (key) => {
          const reason = key.slice(`${MODULE_SCHEDULE_INPUTS_CHANGED_KEY}:`.length);
          if (reason !== "event_times" && reason !== "channel_time_zone" && reason !== "activation" && reason !== "stream_state") return;
          for (const module of modules) {
            for (const registration of module.alarms ?? []) {
              const onScheduleInputsChanged = registration.onScheduleInputsChanged;
              if (onScheduleInputsChanged === undefined) continue;
              await this.runModuleAlarmHandler(module.id, registration.key, () => onScheduleInputsChanged(
                this.moduleAlarmContext(module.id, registration, externalFetchBudget),
                reason,
              ));
            }
          }
        },
      }],
    ]);
    for (const { moduleId, registration } of moduleAlarmHandlerEntries(modules)) {
      const handler = `module:${moduleId}:${registration.key}`;
      if (handlers.has(handler)) throw new Error(`Duplicate alarm handler ${handler}.`);
      const modulePrefix = `module:${moduleId}:`;
      handlers.set(handler, {
        ...(registration.retryDelaysMs === undefined ? {} : { retryDelaysMs: registration.retryDelaysMs }),
        handle: async (key, entry) => {
          const execute = () => registration.handle(
            this.moduleAlarmContext(moduleId, registration, externalFetchBudget, entry.streamGeneration,
              entry.identity, entry.planSequence),
            key.startsWith(modulePrefix) ? key.slice(modulePrefix.length) : key,
            entry.deadline,
            entry.ownerRevision,
          );
          const result = await this.runModuleAlarmHandler(moduleId, registration.key, execute);
          return result === "retain" ? "retain" : undefined;
        },
      });
    }
    const scheduledHandlers = [
      ...CHANNEL_HOST_ALARM_HANDLER_KEYS,
      ...moduleAlarmHandlerEntries(modules).map(({ moduleId, registration }) =>
        `module:${moduleId}:${registration.key}`),
    ];
    const missingHandlers = missingAlarmHandlerKeys(scheduledHandlers, handlers.keys());
    if (missingHandlers.length > 0) {
      throw new Error(`Alarm handlers are not registered: ${missingHandlers.join(", ")}.`);
    }
    return handlers;
  }

  private async dispatchDueAlarmEntries(
    now: number,
    nowIso: string,
    handlers: ReadonlyMap<string, AlarmHandlerRegistration>,
  ): Promise<void> {
    const table = await this.ensureAlarmScheduleTable();
    const dueEntries = Object.entries(table)
      .filter(([, entry]) => alarmAttemptAt(entry) <= now)
      .filter(([, entry]) => !(entry.deadline <= now && entry.suppressedBy !== undefined &&
        Object.hasOwn(table, entry.suppressedBy)))
      .sort(([, left], [, right]) => alarmAttemptAt(left) - alarmAttemptAt(right));

    for (const [key, entry] of dueEntries) {
      const currentTable = await this.ensureAlarmScheduleTable();
      const currentEntry = currentTable[key];
      if (currentEntry === undefined || JSON.stringify(currentEntry) !== JSON.stringify(entry) ||
          alarmAttemptAt(currentEntry) > Date.now()) continue;
      const claimed = await this.claimAlarmEntry(key, entry);
      if (claimed === null) continue;
      const registration = handlers.get(entry.handler);
      if (registration === undefined) {
        console.error(`Alarm handler ${entry.handler} is not registered for ${key}.`);
        await this.rescheduleFailedAlarm(key, claimed, undefined);
        continue;
      }
      try {
        const result = await registration.handle(key, entry, now, nowIso);
        if (result === "retain") await this.retainAlarmEntry(key, claimed);
        else await this.completeAlarmEntry(key, claimed);
      } catch (error: unknown) {
        console.error(`Alarm handler ${entry.handler} failed for ${key}.`, error);
        await this.rescheduleFailedAlarm(key, claimed, registration.retryDelaysMs);
      }
    }
    await this.scheduleEarliestAlarm();
  }

  private async scheduleEarliestAlarm(): Promise<void> {
    const previous = this.alarmScheduleQueue;
    let release!: () => void;
    this.alarmScheduleQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const table = await this.ensureAlarmScheduleTable();
      const nextAlarmAt = earliestAlarmAt(table, Date.now());
      if (nextAlarmAt === null) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.ctx.storage.setAlarm(nextAlarmAt);
    } finally {
      release();
    }
  }

  private async scheduleSecurityAlarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.clearAlarmEntries([SECURITY_DEADLINE_KEY, SECURITY_RETRY_KEY]);
    } else {
      const deadline = await this.readAlarmDeadline(SECURITY_DEADLINE_KEY);
      if (deadline === null) {
        await this.scheduleAlarmEntry(
          SECURITY_DEADLINE_KEY,
          SECURITY_ROUND_HANDLER,
          Date.now() + SECURITY_ALARM_INTERVAL_MS,
          SECURITY_RETRY_KEY,
        );
      }
    }
    await this.scheduleEarliestAlarm();
  }

  private async stopSecurityAlarmIfIdle(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.clearAlarmEntries([SECURITY_DEADLINE_KEY, SECURITY_RETRY_KEY]);
    }
  }

  private async pruneRevokedTokenMarkers(now: number): Promise<void> {
    try {
      let startAfter: string | undefined;
      for (;;) {
        const markers = await this.ctx.storage.list({
          prefix: "overlay_revoked:",
          limit: 1_000,
          ...(startAfter === undefined ? {} : { startAfter }),
        });
        const lastKey = [...markers.keys()].at(-1);
        const updates: Promise<unknown>[] = [];
        for (const [key, value] of markers) {
          if (value === true) {
            // Migrate markers written by earlier code and give any old in-flight
            // handshake one final bounded window to observe them.
            updates.push(this.ctx.storage.put(key, { revokedAt: now } satisfies RevokedTokenMarker));
          } else if (!isRecord(value) || typeof value.revokedAt !== "number" ||
              !Number.isFinite(value.revokedAt) || now - value.revokedAt >= OVERLAY_REVOKED_MARKER_TTL_MS) {
            updates.push(this.ctx.storage.delete(key));
          }
        }
        await Promise.all(updates);
        if (markers.size < 1_000 || lastKey === undefined) break;
        startAfter = lastKey;
      }
    } catch (error: unknown) {
      // Marker retention is opportunistic. D1 remains the authorization
      // source of truth for new handshakes and periodic socket checks.
      console.error("Realtime overlay revocation markers could not be pruned.", error);
    }
  }

  private async getOverlayToken(tokenId: string, channelId: string, nowIso: string): Promise<TokenValidityRow | null> {
    return await this.env.DB.prepare(
      `SELECT token_id, overlay_id
         FROM overlay_tokens
        WHERE channel_id = ?
          AND token_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(channelId, tokenId, nowIso).first<TokenValidityRow>();
  }

  private async panelPrincipalIsCurrent(
    principal: Extract<RealtimePrincipal, { kind: "panel" }>,
    channelId: string,
    now: number,
  ): Promise<boolean> {
    if (isExpired(principal, now)) return false;
    const row = await this.env.DB.prepare(
      `SELECT session.session_id, session.user_id, member.role
         FROM auth_sessions AS session
         JOIN twitch_login_identity AS identity ON identity.user_id = session.user_id
         JOIN channel_members AS member
           ON member.channel_id = ? AND member.user_id = session.user_id
        WHERE session.session_id = ?
          AND session.user_id = ?
          AND member.role = ?
          AND session.revoked_at IS NULL
          AND session.expires_at > ?
          AND identity.status <> 'revoked'`,
    ).bind(channelId, principal.sessionId, principal.userId, principal.role, new Date(now).toISOString())
      .first<SessionValidityRow>();
    return row?.session_id === principal.sessionId && row.user_id === principal.userId && row.role === principal.role;
  }

  private async allowOverlayHandshake(tokenId: string, now: number): Promise<boolean> {
    const key = `overlay_handshakes:${tokenId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const previous = await transaction.get<OverlayHandshakeWindow>(key);
      if (previous === undefined || !Number.isFinite(previous.startedAt) ||
          !Number.isFinite(previous.count) || previous.count < 0 ||
          now - previous.startedAt >= OVERLAY_HANDSHAKE_WINDOW_MS || now < previous.startedAt) {
        await transaction.put(key, { startedAt: now, count: 1 } satisfies OverlayHandshakeWindow);
        return true;
      }
      if (previous.count >= MAX_OVERLAY_HANDSHAKES_PER_TOKEN) return false;
      await transaction.put(key, { ...previous, count: previous.count + 1 });
      return true;
    });
  }

  private hasConnectionCapacity(principal: RealtimePrincipal): boolean {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_CHANNEL_SOCKETS) return false;
    if (principal.kind === "panel") {
      return this.ctx.getWebSockets(`user:${principal.userId}`).length < MAX_PANEL_SOCKETS_PER_USER;
    }
    return this.ctx.getWebSockets("kind:overlay").length < MAX_OVERLAY_SOCKETS_PER_CHANNEL &&
      this.ctx.getWebSockets(`token:${principal.tokenId}`).length < MAX_OVERLAY_SOCKETS_PER_TOKEN;
  }

  public async scheduleAdPrewarning(dueAtMs: number): Promise<void> {
    await this.ensurePointRoundRecovery();
    if (!Number.isFinite(dueAtMs)) {
      await this.clearAdPrewarning();
      return;
    }
    await this.scheduleAlarmEntry(AD_PREWARNING_DEADLINE_KEY, AD_PREWARNING_HANDLER, dueAtMs);
  }

  public async clearAdPrewarning(): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.clearAlarmEntry(AD_PREWARNING_DEADLINE_KEY);
    // The send claim for the occurrence just cleared is kept, not deleted: a
    // re-arm for that same due-at ms (e.g. an unrelated schedule refresh
    // clearing and re-setting the same alarm) must still see it as already
    // sent. Only pruning happens here, to keep the claim map bounded.
    const stored = await this.ctx.storage.get<Record<string, number> | number>(AD_PREWARNING_SEND_CLAIM_KEY);
    if (stored === undefined) return;
    const claims = typeof stored === "number" ? { [String(stored)]: stored } : stored;
    const pruned = prunePrewarningClaims(claims, Date.now());
    if (Object.keys(pruned).length === 0) await this.ctx.storage.delete(AD_PREWARNING_SEND_CLAIM_KEY);
    else await this.ctx.storage.put(AD_PREWARNING_SEND_CLAIM_KEY, pruned);
  }

  /** Persists a per-channel clip job and schedules its alarm. Trigger IDs are idempotent within this channel object. */
  public async enqueueClipJob(
    triggerId: string,
    actorUserId: string | null,
    settings: Pick<ClipsSettings, "postClipLinkInChat" | "chatLinkTemplate">,
    cooldownSeconds: number,
  ): Promise<"enqueued" | "duplicate" | "cooldown"> {
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("The channel Durable Object has no tenant identity.");
    if (triggerId.length === 0 || triggerId.length > 512 ||
        typeof settings.postClipLinkInChat !== "boolean" ||
        typeof settings.chatLinkTemplate !== "string" || settings.chatLinkTemplate.length < 1 || settings.chatLinkTemplate.length > 500 ||
        !Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 86_400) {
      throw new RangeError("Invalid clip job input.");
    }

    const now = Date.now();
    const key = clipJobStorageKey(triggerId);
    if (cooldownSeconds > 0) {
      await this.ensurePointRoundRecovery();
      await this.ensurePointsInitialized();
    }
    const job: StoredClipJob = {
      version: 1,
      channelId,
      triggerId,
      actorUserId,
      settings: { ...settings },
      createdAt: new Date(now).toISOString(),
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
      clipId: null,
      createAttemptedAt: null,
      editUrl: null,
      creationDetail: null,
      confirmedClip: null,
      failure: null,
    };
    const outcome = await this.ctx.storage.transaction(async (transaction): Promise<"enqueued" | "duplicate" | "cooldown"> => {
      if (await transaction.get(key) !== undefined) return "duplicate";
      if (cooldownSeconds > 0 && !claimPointCooldownSync(
        this.ctx.storage.sql,
        "clips",
        "clip",
        cooldownSeconds,
        Date.now(),
      )) return "cooldown";
      await transaction.put(key, job);

      const table = await readAlarmScheduleTable(transaction);
      const currentAlarm = table[CLIP_JOB_ALARM_KEY];
      table[CLIP_JOB_ALARM_KEY] = {
        deadline: now,
        handler: CLIP_JOB_ALARM_HANDLER,
        revision: (currentAlarm?.revision ?? 0) + 1,
      };
      await transaction.put(ALARM_TABLE_KEY, table);
      const nextAlarmAt = earliestAlarmAt(table, now);
      if (nextAlarmAt === null) await transaction.deleteAlarm();
      else await transaction.setAlarm(nextAlarmAt);
      return "enqueued";
    });
    if (outcome !== "enqueued") return outcome;
    await this.pruneCompletedClipJobs(now);
    return "enqueued";
  }

  /** Schedule one module-owned alarm key through its registered handler. */
  public async scheduleModuleAlarm(
    moduleId: string,
    handlerKey: string,
    alarmKey: string,
    deadline: number,
    ownerRevision?: number,
    streamGeneration?: number | null,
    identity?: ModuleAlarmIdentity,
    planSequence?: number,
  ): Promise<void> {
    await this.ensurePointRoundRecovery();
    const registration = MODULES.find((module) => module.id === moduleId)?.alarms?.find((alarm) => alarm.key === handlerKey);
    if (registration === undefined || alarmKey.length === 0) {
      throw new Error(`Unknown module alarm ${moduleId}.${handlerKey}.`);
    }
    await this.scheduleAlarmEntry(
      `module:${moduleId}:${alarmKey}`,
      `module:${moduleId}:${registration.key}`,
      deadline,
      undefined,
      ownerRevision,
      streamGeneration,
      identity,
      planSequence,
    );
  }

  /**
   * Match one-time migration candidates to the exact chat-voting close alarms
   * retained in this channel object's durable schedule.
   */
  private async retainedLegacyChatVoteResultPollIds(): Promise<string[]> {
    const stored = await this.ctx.storage.get(ALARM_TABLE_KEY);
    const prefix = `module:${CHAT_VOTING_MODULE_ID}:`;
    const handler = `module:${CHAT_VOTING_MODULE_ID}:${CHAT_VOTING_ALARM_HANDLER}`;
    return isRecord(stored)
      ? Object.entries(stored).flatMap(([key, entry]) =>
        key.startsWith(prefix) && validAlarmScheduleEntry(entry) && entry.handler === handler
          ? [key.slice(prefix.length)]
          : [])
      : [];
  }

  private async reconcileLegacyChatVoteResultDeliveriesFor(retainedPollIds: readonly string[]): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    await reconcileLegacyChatVoteResultDeliveriesInD1(this.env.DB, channelId, retainedPollIds);
  }

  public async reconcileLegacyChatVoteResultDeliveries(): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.reconcileLegacyChatVoteResultDeliveriesFor(await this.retainedLegacyChatVoteResultPollIds());
  }

  /** Returns the current retry/execution time for one module alarm, if scheduled. */
  public async getModuleAlarmDeadline(moduleId: string, alarmKey: string): Promise<number | null> {
    await this.ensurePointRoundRecovery();
    if (!MODULES.some((module) => module.id === moduleId) || alarmKey.length === 0) return null;
    const stored = await this.ctx.storage.get(ALARM_TABLE_KEY);
    if (!isRecord(stored)) return null;
    const entry = stored[`module:${moduleId}:${alarmKey}`];
    if (!validAlarmScheduleEntry(entry)) return null;
    return entry.claimUntil === undefined ? entry.nextAttemptAt ?? entry.deadline : entry.deadline;
  }

  /** Returns the identity and sequence stored on one module alarm entry. */
  public async getModuleAlarmPlan(moduleId: string, alarmKey: string): Promise<ModuleAlarmPlan | null> {
    await this.ensurePointRoundRecovery();
    if (!MODULES.some((module) => module.id === moduleId) || alarmKey.length === 0) return null;
    const stored = await this.ctx.storage.get(ALARM_TABLE_KEY);
    if (!isRecord(stored)) return null;
    const entry = stored[`module:${moduleId}:${alarmKey}`];
    if (!validAlarmScheduleEntry(entry)) return null;
    return {
      identity: entry.identity ?? null,
      planSequence: entry.planSequence ?? null,
      streamGeneration: entry.streamGeneration ?? null,
    };
  }

  /** Clear one module-owned alarm key without disturbing other module deadlines. */
  public async clearModuleAlarm(
    moduleId: string,
    alarmKey: string,
    ownerRevision?: number,
    streamGeneration?: number | null,
    expectedIdentity?: ModuleAlarmIdentity | null,
    planSequence?: number,
  ): Promise<void> {
    await this.ensurePointRoundRecovery();
    if (!MODULES.some((module) => module.id === moduleId) || alarmKey.length === 0) {
      throw new Error(`Unknown module alarm key ${moduleId}.${alarmKey}.`);
    }
    await this.clearAlarmEntry(`module:${moduleId}:${alarmKey}`, ownerRevision, streamGeneration,
      expectedIdentity, planSequence);
  }

  /** Queues a generic replan after a host or module changes schedule inputs. */
  public async notifyScheduleInputsChanged(reason: ModuleScheduleInputChangeReason): Promise<void> {
    await this.ensurePointRoundRecovery();
    await this.scheduleAlarmEntry(
      `${MODULE_SCHEDULE_INPUTS_CHANGED_KEY}:${reason}`,
      MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER,
      Date.now(),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensurePointRoundRecovery();
    const rawPrincipal = request.headers.get(REALTIME_PRINCIPAL_HEADER);
    let principal: RealtimePrincipal | null = null;
    if (rawPrincipal !== null) {
      try {
        const parsed: unknown = JSON.parse(rawPrincipal);
        principal = isRealtimePrincipal(parsed) ? parsed : null;
      } catch {
        principal = null;
      }
    }

    const ownChannelId = this.ownChannelId();
    if (principal === null || ownChannelId === null || principal.channelId !== ownChannelId) {
      return new Response("Channel access denied.", { status: 403 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    if (request.headers.get("Sec-WebSocket-Protocol") !== REALTIME_PROTOCOL) {
      return new Response("Realtime protocol is not supported.", { status: 426 });
    }

    if (principal.kind === "overlay") {
      let withinHandshakeLimit: boolean;
      try {
        withinHandshakeLimit = await this.allowOverlayHandshake(principal.tokenId, Date.now());
      } catch (error: unknown) {
        console.error("Realtime overlay handshake limit could not be checked.", error);
        return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      }
      if (!withinHandshakeLimit) {
        return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
      }
    }

    // This check follows any awaited rate-limit operation, so the subsequent
    // accept is synchronous and another handshake observes the new socket.
    if (!this.hasConnectionCapacity(principal)) {
      return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
    }

    const pair = new WebSocketPair();
    let overlayTokenAtHandshake: TokenValidityRow | null | undefined;
    if (principal.kind === "overlay") {
      try {
        // D1 protects handshakes whose in-memory revocation marker has aged
        // out. The marker is re-read at the final accept boundary below, so
        // it also catches a revoke that lands while this query is in flight.
        // The same lookup reads the binding so a stale route principal cannot
        // keep a legacy socket after an import binds its token.
        overlayTokenAtHandshake = await this.getOverlayToken(
          principal.tokenId,
          ownChannelId,
          new Date().toISOString(),
        );
        if (overlayTokenAtHandshake === null) {
          return new Response("Overlay token revoked.", { status: 403 });
        }
      } catch (error: unknown) {
        console.error("Realtime overlay revocation could not be checked.", error);
        return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      }
    }
    if (principal.kind === "overlay") {
      try {
        // Re-read the durable marker immediately before acceptance and reuse
        // the D1 authorization result from this handshake.
        const marker: unknown = await this.ctx.storage.get(revokedTokenKey(principal.tokenId));
        if (overlayTokenAtHandshake === null || overlayTokenAtHandshake === undefined || isExpired(principal, Date.now()) ||
            hasActiveRevocationMarker(marker, Date.now())) {
          return new Response("Overlay token revoked.", { status: 403 });
        }
      } catch (error: unknown) {
        console.error("Realtime overlay revocation could not be rechecked.", error);
        return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      }
    }
    if (principal.kind === "overlay" && principal.overlayId === null &&
        this.recentlyBoundOverlayTokenIds.has(principal.tokenId)) {
      closeSocket(pair[1], OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
      return new Response("Overlay token is now bound.", { status: 403 });
    }
    if (principal.kind === "panel") {
      try {
        // Outer route authorization may have gone stale while the request was
        // queued for this object. This D1 check is the final await before the
        // synchronous accept, so revocation prevents even the hello message.
        if (!await this.panelPrincipalIsCurrent(principal, ownChannelId, Date.now())) {
          return new Response("Panel authorization revoked.", { status: 403 });
        }
      } catch (error: unknown) {
        console.error("Realtime panel handshake authorization could not be checked.", error);
        return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      }
    }
    // Authorization above awaits D1 and lets concurrent handshakes interleave.
    // Reserve capacity again at the synchronous acceptance boundary.
    if (!this.hasConnectionCapacity(principal)) {
      return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
    }
    this.ctx.acceptWebSocket(pair[1], tagsFor(principal));
    pair[1].serializeAttachment(principal);
    await this.scheduleSecurityAlarm();
    const overlayBindingChanged = principal.kind === "overlay" &&
      overlayTokenAtHandshake?.overlay_id !== principal.overlayId;
    if (overlayBindingChanged) {
      closeSocket(pair[1], OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
    } else {
      pair[1].send(JSON.stringify(envelopeFor(ownChannelId, "system.hello")));
      if (principal.kind === "panel") {
        try {
          const revisions = await readPanelResourceRevisions(this.env.DB, ownChannelId);
          await this.reconcilePanelResources(revisions);
        } catch (error: unknown) {
          console.warn("Panel resource revision snapshot could not be sent.", error);
        }
      }
    }
    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": REALTIME_PROTOCOL },
      webSocket: pair[0],
    });
  }

  /** Distributes only within its own channel and only to principals of the requested kind. */
  public async publish(
    messages: readonly RealtimeMessage[],
  ): Promise<void> {
    await this.ensurePointRoundRecovery();
    if (messages.length === 0) return Promise.resolve();
    const ownChannelId = this.ownChannelId();
    if (ownChannelId === null || messages.some((message) => message.channelId !== ownChannelId)) {
      throw new Error("Realtime message belongs to a foreign channel.");
    }
    const now = Date.now();
    const ordinarySockets = messages.some((message) => message.type !== "overlay.changed" &&
      message.type !== "panel.resources.changed" &&
      !isModuleOverlayRealtimeEnvelope(message))
      ? this.ctx.getWebSockets()
      : [];
    const overlaySocketsById = new Map<string, WebSocket[]>();
    const targetedOverlayIds = new Set(messages.flatMap((message) =>
      message.type === "overlay.changed" ? [message.payload.overlayId]
        : isModuleOverlayRealtimeEnvelope(message) ? [...(message.overlayIds ?? [])] : []));
    for (const overlayId of targetedOverlayIds) {
      overlaySocketsById.set(overlayId, this.ctx.getWebSockets(`overlay:${overlayId}`));
    }
    const serialized = messages.map((envelope) => ({
      envelope,
      payload: JSON.stringify(isModuleOverlayRealtimeEnvelope(envelope)
        ? {
          version: envelope.version,
          id: envelope.id,
          createdAt: envelope.createdAt,
          channelId: envelope.channelId,
          type: envelope.type,
          payload: envelope.payload,
        }
        : envelope.type === "variables.changed"
          ? { ...envelope, payload: { set: envelope.payload.set, removed: envelope.payload.removed } }
          : envelope),
      sockets: envelope.type === "overlay.changed"
        ? [
          ...this.ctx.getWebSockets("kind:panel"),
          ...(overlaySocketsById.get(envelope.payload.overlayId) ?? []),
        ]
        : envelope.type === "panel.resources.changed"
          ? this.ctx.getWebSockets("kind:panel")
        : isModuleOverlayRealtimeEnvelope(envelope)
          ? [...new Set((envelope.overlayIds ?? []).flatMap((overlayId) => overlaySocketsById.get(overlayId) ?? []))]
          : ordinarySockets,
    }));
    const panelRecipients = [...new Set(serialized.flatMap(({ sockets }) => sockets)
      .filter((webSocket) => readAttachment(webSocket)?.kind === "panel"))];
    const authorizedPanels = new Set<WebSocket>();
    const unavailablePanels = new Set<WebSocket>();
    const panelSessions = new Map<string, WebSocket[]>();
    for (const webSocket of panelRecipients) {
      const principal = readAttachment(webSocket);
      if (principal?.kind !== "panel") continue;
      const sockets = panelSessions.get(principal.sessionId) ?? [];
      sockets.push(webSocket);
      panelSessions.set(principal.sessionId, sockets);
    }
    for (const sessionIds of chunksOf([...panelSessions.keys()], D1_IDS_PER_QUERY)) {
      const placeholders = sessionIds.map(() => "?").join(", ");
      try {
        const result = await this.env.DB.prepare(
          `SELECT session.session_id, session.user_id, member.role
             FROM auth_sessions AS session
             JOIN twitch_login_identity AS identity ON identity.user_id = session.user_id
             JOIN channel_members AS member
               ON member.channel_id = ? AND member.user_id = session.user_id
            WHERE session.session_id IN (${placeholders})
              AND session.revoked_at IS NULL
              AND session.expires_at > ?
              AND identity.status <> 'revoked'`,
        ).bind(ownChannelId, ...sessionIds, new Date(now).toISOString()).all<SessionValidityRow>();
        const validSessions = new Set(result.results.map((row) =>
          `${row.session_id}:${row.user_id}:${String(row.role)}`));
        for (const sessionId of sessionIds) {
          for (const webSocket of panelSessions.get(sessionId) ?? []) {
            const principal = readAttachment(webSocket);
            if (principal?.kind === "panel" && validSessions.has(
              `${principal.sessionId}:${principal.userId}:${principal.role}`,
            )) authorizedPanels.add(webSocket);
          }
        }
      } catch (error: unknown) {
        console.error("Realtime panel authorization check failed.", error);
        for (const sessionId of sessionIds) {
          for (const webSocket of panelSessions.get(sessionId) ?? []) {
            unavailablePanels.add(webSocket);
            closeSocket(webSocket, SOCKET_TRANSIENT_CODE, "authorization check unavailable");
          }
        }
      }
    }
    for (const message of serialized) {
      const envelope = message.envelope;
      for (const webSocket of message.sockets) {
        const principal = readAttachment(webSocket);
        if (principal === null || principal.channelId !== ownChannelId) {
          closeSocket(webSocket, SOCKET_REVOKED_CODE, "invalid principal");
          continue;
        }
        if (isExpired(principal, now)) {
          closeSocket(webSocket, SOCKET_EXPIRED_CODE, "authorization expired");
          continue;
        }
        if (principal.kind === "panel" && unavailablePanels.has(webSocket)) continue;
        if (principal.kind === "panel" && !authorizedPanels.has(webSocket)) {
          closeSocket(webSocket, SOCKET_REVOKED_CODE, "authorization revoked");
          continue;
        }
        if (envelope.type === "variables.changed" && principal.kind === "overlay" &&
            principal.overlayId === null && this.recentlyBoundOverlayTokenIds.has(principal.tokenId)) {
          closeSocket(webSocket, OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
          continue;
        }
        if (envelope.type === "overlay.changed" && principal.kind === "overlay" &&
            principal.overlayId !== envelope.payload.overlayId) continue;
        let serializedPayload = message.payload;
        if (envelope.type === "variables.changed" && principal.kind === "overlay" && principal.overlayId !== null) {
          const overlayId = principal.overlayId;
          const overlayIdsByVariable = envelope.payload.overlayIdsByVariable ?? {};
          const referencesOverlay = (name: string): boolean =>
            Array.isArray(overlayIdsByVariable[name]) && overlayIdsByVariable[name].includes(overlayId);
          const set = envelope.payload.set.filter((entry) => referencesOverlay(entry.name));
          const removed = envelope.payload.removed.filter(referencesOverlay);
          if (set.length === 0 && removed.length === 0) continue;
          serializedPayload = JSON.stringify({ ...envelope, payload: { set, removed } });
        }
        try {
          const recipients: readonly RealtimeRecipientKind[] = realtimeRecipients(envelope.type);
          if (recipients.includes(principal.kind)) webSocket.send(serializedPayload);
        } catch {
          closeSocket(webSocket, SOCKET_TRANSIENT_CODE, "connection unavailable");
        }
      }
    }
    return Promise.resolve();
  }

  public async revokeSession(sessionId: string): Promise<void> {
    await this.ensurePointRoundRecovery();
    for (const webSocket of this.ctx.getWebSockets(`session:${sessionId}`)) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Session revoked");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  public async revokeUser(userId: string): Promise<void> {
    await this.ensurePointRoundRecovery();
    for (const webSocket of this.ctx.getWebSockets(`user:${userId}`)) {
      const principal = readAttachment(webSocket);
      if (principal?.kind === "panel" && principal.userId === userId) {
        const channelId = this.ownChannelId();
        if (channelId !== null && principal.channelId === channelId) {
          try {
            if (await this.panelPrincipalIsCurrent(principal, channelId, Date.now())) continue;
          } catch (error: unknown) {
            console.error("Realtime panel revocation check failed.", error);
            throw error;
          }
        }
      }
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Channel access revoked");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  public async revokeToken(tokenId: string): Promise<boolean> {
    await this.ensurePointRoundRecovery();
    const now = Date.now();
    await this.pruneRevokedTokenMarkers(now);
    // A short-lived marker blocks handshakes already in flight while the
    // route's D1 revocation propagates. D1 validates every accepted handshake.
    await this.ctx.storage.put(revokedTokenKey(tokenId), { revokedAt: now } satisfies RevokedTokenMarker);
    const sockets = this.ctx.getWebSockets(`token:${tokenId}`);
    await this.ctx.storage.delete(`overlay_handshakes:${tokenId}`);
    if (sockets.length > 0) {
      // Schedule the marker check before attempting close. This also covers a
      // DO call that times out after the durable revoke has been recorded.
      await this.scheduleAlarmEntry(
        SECURITY_RETRY_KEY,
        SECURITY_RETRY_HANDLER,
        Date.now() + SECURITY_RETRY_INTERVAL_MS,
      );
    }
    let closed = true;
    for (const webSocket of sockets) {
      if (!closeSocket(webSocket, SOCKET_REVOKED_CODE, "Overlay token revoked")) closed = false;
    }
    await this.stopSecurityAlarmIfIdle();
    if (!closed) await this.scheduleEarliestAlarm();
    return closed;
  }

  public async closeUnboundOverlayTokenSockets(tokenId: string): Promise<boolean> {
    await this.ensurePointRoundRecovery();
    const ownChannelId = this.ownChannelId();
    this.recentlyBoundOverlayTokenIds.add(tokenId);
    let closed = true;
    for (const webSocket of this.ctx.getWebSockets(`token:${tokenId}`)) {
      const principal = readAttachment(webSocket);
      if (principal?.kind !== "overlay" || principal.channelId !== ownChannelId ||
          principal.tokenId !== tokenId || principal.overlayId !== null) continue;
      if (!closeSocket(webSocket, OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON)) closed = false;
    }
    await this.stopSecurityAlarmIfIdle();
    return closed;
  }

  private async runSecurityRound(now: number, nowIso: string): Promise<AlarmHandlerResult> {
    const webSockets = this.ctx.getWebSockets();
    const expired = new Set<WebSocket>();
    const revoked = new Set<WebSocket>();
    const overlayBindingChanged = new Set<WebSocket>();
    // Sockets whose authorization batch could not be checked this round. They
    // are closed with the transient code so clients reconnect and are
    // re-authorized on handshake, instead of staying subscribed past the
    // backstop while D1 keeps failing.
    const transientAuth = new Set<WebSocket>();
    let transientFailure = false;

    const principals = webSockets.map((webSocket) => ({ webSocket, principal: readAttachment(webSocket) }));

    if (webSockets.length > 0) {
      for (const { webSocket, principal } of principals) {
        if (principal === null) revoked.add(webSocket);
        else if (isExpired(principal, now)) expired.add(webSocket);
        else if (principal.kind === "overlay") {
          try {
            if (await this.ctx.storage.get<boolean>(revokedTokenKey(principal.tokenId)) === true) {
              revoked.add(webSocket);
            }
          } catch (error: unknown) {
            console.error("Realtime overlay revocation marker could not be checked.", error);
          }
        }
      }
    }

    if (webSockets.length > 0) try {
      const ownChannelId = this.ownChannelId();
      if (ownChannelId === null) {
        for (const webSocket of webSockets) revoked.add(webSocket);
      } else {
        const panelPrincipals = principals.flatMap(({ webSocket, principal }) =>
          principal?.kind === "panel" && !expired.has(webSocket) && !revoked.has(webSocket) ? [{ webSocket, principal }] : []);
        const overlayPrincipals = principals.flatMap(({ webSocket, principal }) =>
          principal?.kind === "overlay" && !expired.has(webSocket) && !revoked.has(webSocket) ? [{ webSocket, principal }] : []);

        const sessionIds = [...new Set(panelPrincipals.map(({ principal }) => principal.sessionId))];
        for (const batch of chunksOf(sessionIds, D1_IDS_PER_QUERY)) {
          const placeholders = batch.map(() => "?").join(", ");
          try {
            const result = await this.env.DB.prepare(
              `SELECT session.session_id, session.user_id, member.role
                 FROM auth_sessions AS session
                 JOIN twitch_login_identity AS identity ON identity.user_id = session.user_id
                 LEFT JOIN channel_members AS member
                   ON member.channel_id = ? AND member.user_id = session.user_id
                WHERE session.session_id IN (${placeholders})
                  AND session.revoked_at IS NULL
                  AND session.expires_at > ?
                  AND identity.status <> 'revoked'`,
            ).bind(ownChannelId, ...batch, nowIso).all<SessionValidityRow>();
            const validSessions = new Set(result.results
              .filter((row) => row.role !== null)
              .map((row) => `${row.session_id}:${row.user_id}:${String(row.role)}`));
            for (const { webSocket, principal } of panelPrincipals) {
              if (batch.includes(principal.sessionId) &&
                  !validSessions.has(`${principal.sessionId}:${principal.userId}:${principal.role}`)) {
                revoked.add(webSocket);
              }
            }
          } catch (error: unknown) {
            transientFailure = true;
            console.error("Realtime session authorization check failed.", error);
            for (const { webSocket, principal } of panelPrincipals) {
              if (batch.includes(principal.sessionId)) transientAuth.add(webSocket);
            }
          }
        }

        const tokenIds = [...new Set(overlayPrincipals.map(({ principal }) => principal.tokenId))];
        for (const batch of chunksOf(tokenIds, D1_IDS_PER_QUERY)) {
          const placeholders = batch.map(() => "?").join(", ");
          try {
            const result = await this.env.DB.prepare(
              `SELECT token_id, overlay_id
                 FROM overlay_tokens
                WHERE channel_id = ?
                  AND token_id IN (${placeholders})
                  AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)`,
            ).bind(ownChannelId, ...batch, nowIso).all<TokenValidityRow>();
            const validTokens = new Map(result.results.map((row) => [row.token_id, row.overlay_id]));
            for (const { webSocket, principal } of overlayPrincipals) {
              if (!batch.includes(principal.tokenId)) continue;
              const currentOverlayId = validTokens.get(principal.tokenId);
              if (currentOverlayId === undefined) revoked.add(webSocket);
              else if (currentOverlayId !== principal.overlayId) overlayBindingChanged.add(webSocket);
            }
          } catch (error: unknown) {
            transientFailure = true;
            console.error("Realtime overlay token authorization check failed.", error);
            for (const { webSocket, principal } of overlayPrincipals) {
              if (batch.includes(principal.tokenId)) transientAuth.add(webSocket);
            }
          }
        }
      }
    } catch (error: unknown) {
      // Keep connections open when authorization cannot be checked. D1 errors
      // are transient; a separate retry alarm repeats the incomplete round.
      transientFailure = true;
      console.error("Realtime authorization round failed.", error);
    }

    let closeFailure = false;
    for (const webSocket of expired) {
      if (!closeSocket(webSocket, SOCKET_EXPIRED_CODE, "Authorization expired")) closeFailure = true;
    }
    for (const webSocket of revoked) {
      if (!closeSocket(webSocket, SOCKET_REVOKED_CODE, "Authorization revoked")) closeFailure = true;
    }
    for (const webSocket of overlayBindingChanged) {
      if (!closeSocket(webSocket, OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON)) closeFailure = true;
    }
    for (const webSocket of transientAuth) {
      if (expired.has(webSocket) || revoked.has(webSocket) || overlayBindingChanged.has(webSocket)) continue;
      if (!closeSocket(webSocket, SOCKET_TRANSIENT_CODE, "authorization check unavailable")) closeFailure = true;
    }
    if (closeFailure) transientFailure = true;

    if (this.ctx.getWebSockets().length === 0) {
      await this.clearAlarmEntries([SECURITY_DEADLINE_KEY, SECURITY_RETRY_KEY]);
      return undefined;
    } else if (transientFailure) {
      await this.scheduleAlarmEntry(
        SECURITY_RETRY_KEY,
        SECURITY_RETRY_HANDLER,
        now + SECURITY_RETRY_INTERVAL_MS,
      );
      return "retain";
    }

    await this.clearAlarmEntry(SECURITY_RETRY_KEY);
    await this.scheduleAlarmEntry(
      SECURITY_DEADLINE_KEY,
      SECURITY_ROUND_HANDLER,
      now + SECURITY_ALARM_INTERVAL_MS,
      SECURITY_RETRY_KEY,
    );
  }

  private async runAdPrewarning(deadline: number, nowIso: string): Promise<undefined> {
    const ownChannel = this.ownChannelId();
    if (ownChannel === null) return undefined;
    await processAdPrewarning(
      this.env,
      ownChannel,
      deadline,
      undefined,
      nowIso,
      fetch,
      // Own scheduler instead of a stub: a stub to this same object would
      // be a self-call from within alarm() and would never return.
      {
        schedule: async (dueAtMs) => { await this.scheduleAdPrewarning(dueAtMs); },
        clear: async () => { await this.clearAdPrewarning(); },
        readScheduleGeneration: () => this.getAdScheduleGeneration(),
        readSchedule: async () => (await this.getCachedAdSchedule())?.schedule ?? null,
        claimPrewarningSend: async (scheduledDueAtMs) => await this.ctx.storage.transaction(async (transaction) => {
          // Pre-migration deployments stored a single number here instead of
          // a per-occurrence map; fold that legacy shape in rather than
          // dropping it, so an in-flight upgrade cannot forget a real claim.
          const stored = await transaction.get<Record<string, number> | number>(AD_PREWARNING_SEND_CLAIM_KEY);
          const claims = typeof stored === "number" ? { [String(stored)]: stored } : stored ?? {};
          const key = String(scheduledDueAtMs);
          if (Object.hasOwn(claims, key)) return false;
          // Exempt from the shared automated-output limit: an ad prewarning
          // is time-critical (it must land before the ad break starts) and
          // infrequent, unlike timers/FAQ, which yield to each other on that
          // shared slot. Gating it the same way meant a timer or FAQ reply
          // that took the slot within the last 5s made this occurrence
          // "already_attempted" with no retry (see ad-prewarning.ts's
          // isRetryablePrePostFailure, which deliberately excludes it).
          const pruned = prunePrewarningClaims(claims, Date.now());
          pruned[key] = scheduledDueAtMs;
          await transaction.put(AD_PREWARNING_SEND_CLAIM_KEY, pruned);
          return true;
        }),
        recordSentChatMessage: (senderId, text) => this.recordBotChatMessage(senderId, text),
        storeSchedule: async (schedule, asOf, options) => {
          return await this.storeAdSchedule(
            schedule,
            asOf,
            undefined,
            options?.expectedGeneration,
            options?.reconcileAlarm,
          );
        },
      },
    );
    return undefined;
  }

  override async alarm(): Promise<void> {
    await withCommittedPanelResourceDrain(async () => {
      await this.ensurePointRoundRecovery();
      const alarmTable = await this.ctx.storage.transaction((transaction) => readAlarmScheduleTable(transaction));
      const hasTimerAlarms = Object.keys(alarmTable).some((key) =>
        key.startsWith(`${TIMER_ALARM_PREFIX}timer:`) || key.startsWith(`${TIMER_ALARM_PREFIX}mirror:`));
      if (hasTimerAlarms) await this.ensureTimerSchedulesInitialized();
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const externalFetchBudget = createModuleExternalFetchBudget();
      await this.pruneRevokedTokenMarkers(now);
      await this.stopSecurityAlarmIfIdle();
      // Only a retained close retry can change vote-result delivery state here.
      // Reference reads reconcile orphaned migration candidates independently.
      const retainedVoteResults = await this.retainedLegacyChatVoteResultPollIds();
      if (retainedVoteResults.length > 0) {
        await this.reconcileLegacyChatVoteResultDeliveriesFor(retainedVoteResults);
      }
      await this.dispatchDueAlarmEntries(now, nowIso, this.alarmHandlers(MODULES, externalFetchBudget));
    }, () => this.notifyCommittedPanelResources());
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    // This socket is one-way. Closing data senders prevents authenticated
    // clients from waking the object with an unbounded stream of frames.
    void webSocket;
    void message;
    closeSocket(webSocket, SOCKET_POLICY_VIOLATION_CODE, "Realtime channel is one-way");
  }

  override webSocketClose(webSocket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    void webSocket;
    void code;
    void reason;
    void wasClean;
    void this.stopSecurityAlarmIfIdle();
  }
}
