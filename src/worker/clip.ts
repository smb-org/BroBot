import { helixRequest } from "./twitch/helix";
import { configuredClipLinkMessage } from "../modules/clips/domain";
import type { ClipsSettings } from "../modules/clips/contracts";
import type { ModuleDiagnostic } from "../modules/contract";
import { writeModuleAudit } from "./module-audit";
import { sendChatMessage, type ChatSendResult } from "./chat";
import { readBotCredentials } from "./auth/bot-credentials";
import type { EventCode } from "../contracts/values";
import { moduleEnabledForChannel, readChannelControls } from "./db/channel-controls";
import { chatOutputSuppressionReason, type ChatOutputSuppressionReason } from "./chat-output-gate";
import { writeChannelTimelineEvent } from "./db/timeline-events";

const CREATE_CLIP_URL = "https://api.twitch.tv/helix/clips";
const CONFIRM_CLIP_URL = "https://api.twitch.tv/helix/clips";
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIRMATION_INTERVAL_MS = 2_000;

export interface CreateClipResult {
  created: boolean;
  /** Machine-readable reason when the clip was not created. */
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
  clipId: string | null;
  editUrl: string | null;
  title?: string;
  url?: string;
}

type ClipCreationDelivery = "not_attempted" | "rejected" | "ambiguous" | "accepted";
export type ClipCreationResult = Pick<CreateClipResult, "created" | "reason" | "detail" | "clipId" | "editUrl"> & {
  delivery: ClipCreationDelivery;
};

export interface ClipAvailabilityOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const failure = (
  reason: string,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): CreateClipResult => ({ created: false, reason, detail, clipId: null, editUrl: null });

const creationFailure = (
  reason: string,
  delivery: Exclude<ClipCreationDelivery, "accepted">,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): ClipCreationResult => ({ ...failure(reason, detail), delivery });

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const availableClip = (value: unknown, clipId: string): Record<string, unknown> | null => {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const data: unknown[] = value.data;
  const clip: unknown = data.find((item: unknown) => isRecord(item) && item.id === clipId);
  return isRecord(clip) ? clip : null;
};

/** The status-to-reason mapping is this endpoint's own business meaning, not `helixRequest`'s. */
const clipReasonFor = (status: number): string => {
  if (status === 429) return "rate_limited";
  if (status === 401) return "scope_missing";
  // Twitch rejects Create Clip with 400 when the channel isn't currently live.
  if (status === 400) return "not_live";
  return `http_${String(status)}`;
};

/**
 * Creates a clip on the bot's own identity -- the bot already carries
 * `clips:edit` (see `auth/oauth.ts`'s `BOT_SCOPES`), so this needs no
 * broadcaster consent, unlike ads snooze/commercial.
 */
const requestClipCreation = async (
  environment: { TWITCH_CLIENT_ID: string },
  accessToken: string,
  channelId: string,
  fetcher: typeof fetch = fetch,
): Promise<ClipCreationResult> => {
  let result: Awaited<ReturnType<typeof helixRequest<Record<string, unknown>>>>;
  try {
    result = await helixRequest<Record<string, unknown>>({
      method: "POST",
      url: CREATE_CLIP_URL,
      query: { broadcaster_id: channelId },
      accessToken,
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
  } catch {
    return creationFailure("network_error", "ambiguous", { status: null });
  }
  if (!result.ok) {
    if (result.reason === "timeout" || result.reason === "network_error") {
      return creationFailure(result.reason, "ambiguous", { status: null, twitchMessage: result.message });
    }
    const delivery = result.status !== null && result.status >= 400 && result.status < 500 ? "rejected" : "ambiguous";
    return creationFailure(clipReasonFor(result.status ?? 0), delivery, {
      status: result.status,
      twitchMessage: result.message,
      ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }),
    });
  }

  const body = isRecord(result.data) ? result.data : {};
  const first = Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : {};
  const clipId = textOrNull(first.id);
  if (clipId === null) return creationFailure("missing_clip_id", "ambiguous", { status: result.status });

  return {
    created: true,
    delivery: "accepted",
    reason: null,
    detail: { status: result.status },
    clipId,
    editUrl: textOrNull(first.edit_url),
  };
};

const confirmClipAvailability = async (
  environment: { TWITCH_CLIENT_ID: string },
  accessToken: string,
  creation: ClipCreationResult,
  fetcher: typeof fetch = fetch,
  availabilityOptions: ClipAvailabilityOptions = {},
): Promise<CreateClipResult> => {
  if (!creation.created || creation.clipId === null) {
    return failure(creation.reason ?? "missing_clip_id", creation.detail);
  }
  const clipId = creation.clipId;
  const timeoutMs = availabilityOptions.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const pollIntervalMs = availabilityOptions.pollIntervalMs ?? DEFAULT_CONFIRMATION_INTERVAL_MS;
  const now = availabilityOptions.now ?? Date.now;
  const wait = availabilityOptions.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  const availabilityTimeout = (): CreateClipResult => failure("availability_timeout", {
    status: creation.detail.status ?? null,
    waitedMs: timeoutMs,
  });
  for (;;) {
    const requestTimeoutMs = deadline - now();
    if (requestTimeoutMs <= 0) return availabilityTimeout();
    const availability = await helixRequest<Record<string, unknown>>({
      method: "GET",
      url: CONFIRM_CLIP_URL,
      query: { id: clipId },
      accessToken,
      clientId: environment.TWITCH_CLIENT_ID,
      timeoutMs: requestTimeoutMs,
      fetcher,
    });
    if (now() > deadline) return availabilityTimeout();
    if (!availability.ok) {
      if (availability.reason === "timeout") return availabilityTimeout();
      const reason = availability.reason === "rate_limited"
        ? "rate_limited"
        : availability.reason === "network_error"
          ? availability.reason
          : "availability_check_failed";
      return failure(reason, {
        status: availability.status,
        twitchMessage: availability.message,
        ...(availability.retryAfter === undefined ? {} : { retryAfter: availability.retryAfter }),
      });
    }
    const confirmedClip = availableClip(availability.data, clipId);
    if (confirmedClip !== null) {
      return {
        created: true,
        reason: null,
        detail: { ...creation.detail, confirmationStatus: availability.status },
        clipId,
        editUrl: creation.editUrl,
        title: textOrNull(confirmedClip.title) ?? clipId,
        url: textOrNull(confirmedClip.url) ?? `https://clips.twitch.tv/${encodeURIComponent(clipId)}`,
      };
    }

    const remaining = deadline - now();
    if (remaining <= 0) return availabilityTimeout();
    await wait(Math.min(pollIntervalMs, remaining));
  }
};

/** Creates and confirms a clip through the same durable checkpoints used by alarm jobs. */
export const createClip = async (
  environment: { TWITCH_CLIENT_ID: string },
  accessToken: string,
  channelId: string,
  fetcher: typeof fetch = fetch,
  availabilityOptions: ClipAvailabilityOptions = {},
): Promise<CreateClipResult> => {
  const creation = await requestClipCreation(environment, accessToken, channelId, fetcher);
  if (!creation.created) return failure(creation.reason ?? "clip_creation_failed", creation.detail);
  return await confirmClipAvailability(environment, accessToken, creation, fetcher, availabilityOptions);
};

export type ClipWorkflowEnvironment = {
  DB: Env["DB"];
  TWITCH_CLIENT_ID: Env["TWITCH_CLIENT_ID"];
  TWITCH_CLIENT_SECRET: Env["TWITCH_CLIENT_SECRET"];
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
  CHANNEL?: Env["CHANNEL"];
};

export const requestChannelClipCreation = async (
  environment: ClipWorkflowEnvironment,
  channelId: string,
  fetcher: typeof fetch = fetch,
): Promise<ClipCreationResult> => {
  let credentials: Awaited<ReturnType<typeof readBotCredentials>>;
  try {
    credentials = await readBotCredentials(environment);
  } catch {
    return creationFailure("bot_credentials_unavailable", "not_attempted");
  }
  return credentials === null
    ? creationFailure("bot_identity_missing", "not_attempted")
    : await requestClipCreation(environment, credentials.accessToken, channelId, fetcher);
};

export const confirmChannelClipAvailability = async (
  environment: ClipWorkflowEnvironment,
  creation: ClipCreationResult,
  fetcher: typeof fetch = fetch,
  availabilityOptions: ClipAvailabilityOptions = {},
): Promise<CreateClipResult> => {
  const credentials = await readBotCredentials(environment);
  return credentials === null
    ? failure("bot_identity_missing")
    : await confirmClipAvailability(environment, credentials.accessToken, creation, fetcher, availabilityOptions);
};

export interface CreateAndPostClipResult {
  clip: CreateClipResult;
  diagnostics: readonly ModuleDiagnostic[];
  /** Helix retry deadline returned by a rate-limited chat send. */
  retryAfter?: number;
}

export interface ClipChatSendHooks {
  claimBeforePost?: () => Promise<boolean | "rate_limited">;
  afterPost?: (delivery: ChatSendResult["delivery"], reason: string | null) => Promise<void>;
}

const clipFailureDiagnostic = (clip: CreateClipResult): ModuleDiagnostic => ({
  code: "host.clip.failed" satisfies EventCode,
  detail: { reason: clip.reason ?? "unknown_error", ...clip.detail },
});

/** Posts the configured link for a confirmed clip, rechecking channel controls immediately before sending. */
export const postConfirmedClipLink = async (
  environment: ClipWorkflowEnvironment,
  channelId: string,
  actorUserId: string | null,
  settings: Pick<ClipsSettings, "postClipLinkInChat" | "chatLinkTemplate">,
  clip: CreateClipResult,
  fetcher: typeof fetch = fetch,
  triggerId?: string,
  sendHooks: ClipChatSendHooks = {},
): Promise<CreateAndPostClipResult> => {
  if (!clip.created || clip.clipId === null) return { clip, diagnostics: [clipFailureDiagnostic(clip)] };

  const createdAt = new Date().toISOString();
  await writeModuleAudit(
    environment.DB,
    actorUserId ?? "system",
    createdAt,
    {
      channelId,
      moduleId: null,
      action: "clip.created",
      before: null,
      after: { clipId: clip.clipId, availabilityConfirmed: true },
    },
    actorUserId === null ? "system" : "member",
    triggerId === undefined ? undefined : {
      operationId: `clip-created:${encodeURIComponent(channelId)}:${encodeURIComponent(triggerId)}`,
      actorUserId: actorUserId ?? "system",
    },
  );
  try {
    await writeChannelTimelineEvent(environment.DB, channelId, {
      kind: "clip_created",
      identity: clip.clipId,
      occurredAt: createdAt,
      detail: { clipId: clip.clipId },
    });
  } catch (error: unknown) {
    console.warn("Confirmed clip timeline event could not be recorded.", error);
  }

  const message = configuredClipLinkMessage(settings, {
    title: clip.title ?? clip.clipId,
    url: clip.url ?? `https://clips.twitch.tv/${encodeURIComponent(clip.clipId)}`,
  });
  if (message === null) return { clip, diagnostics: [] };

  const outputGate: { suppressionReason: ChatOutputSuppressionReason | null; controlsUnavailable: boolean } = {
    suppressionReason: null,
    controlsUnavailable: false,
  };
  const sent = await sendChatMessage(environment, channelId, message, undefined, fetcher, async () => {
    try {
      const [controls, moduleEnabled] = await Promise.all([
        readChannelControls(environment.DB, channelId, new Date().toISOString()),
        moduleEnabledForChannel(environment.DB, channelId, "clips"),
      ]);
      outputGate.suppressionReason = chatOutputSuppressionReason({
        moduleEnabled,
        mandatory: false,
        paused: controls.pause.active,
        muted: controls.mute.active,
      });
      return outputGate.suppressionReason === null;
    } catch {
      outputGate.controlsUnavailable = true;
      return false;
    }
  }, sendHooks.claimBeforePost, [], sendHooks.afterPost);
  return {
    clip,
    ...(typeof sent.detail.retryAfter === "number" ? { retryAfter: sent.detail.retryAfter } : {}),
    diagnostics: [
      ...(sent.truncated ? [{ code: "template_truncated" as const, detail: { current: message.length } }] : []),
      ...(outputGate.suppressionReason !== null
        ? [{ code: "host.action.suppressed" as const, detail: { action: "chat", reason: outputGate.suppressionReason } }]
        : outputGate.controlsUnavailable
          ? [{ code: "host.chat.failed" as const, detail: { reason: "channel_controls_unavailable", ...sent.detail } }]
          : [sent.sent
            ? { code: "host.chat.sent" as const, detail: sent.detail }
            : { code: "host.chat.failed" as const, detail: { reason: sent.reason ?? "unknown_error", ...sent.detail } }]),
    ],
  };
};

/** Creates and confirms a channel clip, then uses its configured chat message. */
export const createAndPostConfiguredClipLink = async (
  environment: ClipWorkflowEnvironment,
  channelId: string,
  actorUserId: string,
  settings: Pick<ClipsSettings, "postClipLinkInChat" | "chatLinkTemplate">,
  fetcher: typeof fetch = fetch,
  triggerId?: string,
): Promise<CreateAndPostClipResult> => {
  const creation = await requestChannelClipCreation(environment, channelId, fetcher);
  const clip = creation.created
    ? await confirmChannelClipAvailability(environment, creation, fetcher)
    : creation;
  if (!clip.created) return { clip, diagnostics: [clipFailureDiagnostic(clip)] };
  return await postConfirmedClipLink(environment, channelId, actorUserId, settings, clip, fetcher, triggerId);
};
