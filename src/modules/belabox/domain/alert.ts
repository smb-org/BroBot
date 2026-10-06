import type { BelaboxFetchFailureReason } from "../contracts";

export type BelaboxAlertKind = "low" | "disconnect";
export type BelaboxAlertPhase = "ok" | "pending" | "alarm" | "recovering";
export type BelaboxAlertMessageKind = "low" | "disconnect" | "recovery";
export type BelaboxAlertIdempotencyKind = "alert" | "escalate" | "recovered";

export interface BelaboxAlertSettings {
  alertsEnabled: boolean;
  lowBitrateKbps: number;
  recoverBitrateKbps: number;
  holdSeconds: number;
  recoverHoldSeconds: number;
  chatCooldownSeconds: number;
  chatEnabled: boolean;
}

export type BelaboxAlertSample =
  | { at: string; connected: boolean; bitrateKbps: number }
  | { kind: "fetch_error"; at: string; reason: BelaboxFetchFailureReason }
  | { kind: "stream_offline" };

export interface BelaboxAlertChatOutput {
  kind: BelaboxAlertMessageKind;
  idempotencyKind: BelaboxAlertIdempotencyKind;
  episodeStartedAt: string;
  alertKind: BelaboxAlertKind;
  validPhase: "alarm" | "ok";
  threshold: number;
  seconds: number;
}

export interface BelaboxAlertState {
  phase: BelaboxAlertPhase;
  kind: BelaboxAlertKind | null;
  since: string | null;
  episodeStartedAt: string | null;
  completedEpisodeAt: string | null;
  lastChatSentAt: string | null;
  chatSentInEpisode: boolean;
  pendingChat: BelaboxAlertChatOutput | null;
}

export type BelaboxAlertDiagnostic =
  | { code: "belabox.alert_started"; detail: { kind: BelaboxAlertKind; threshold: number; seconds: number } }
  | { code: "belabox.alert_escalated"; detail: { kind: "disconnect"; threshold: number; seconds: number } }
  | { code: "belabox.alert_recovered"; detail: { kind: BelaboxAlertKind; threshold: number; seconds: number } };

export interface BelaboxAlertAdvance {
  state: BelaboxAlertState;
  outputs: {
    phaseChange: BelaboxAlertDiagnostic | null;
    chat: BelaboxAlertChatOutput | null;
  };
}

export const createInitialAlertState = (): BelaboxAlertState => ({
  phase: "ok",
  kind: null,
  since: null,
  episodeStartedAt: null,
  completedEpisodeAt: null,
  lastChatSentAt: null,
  chatSentInEpisode: false,
  pendingChat: null,
});

const elapsedSeconds = (start: string, end: string): number | null => {
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.floor(elapsed / 1_000) : null;
};

const failingKind = (
  sample: Extract<BelaboxAlertSample, { at: string; connected: boolean }>,
  settings: BelaboxAlertSettings,
): BelaboxAlertKind | null => !sample.connected
  ? "disconnect"
  : sample.bitrateKbps < settings.lowBitrateKbps
    ? "low"
    : null;

const pendingMessage = (
  kind: BelaboxAlertKind,
  idempotencyKind: BelaboxAlertIdempotencyKind,
  episodeStartedAt: string,
  settings: BelaboxAlertSettings,
): BelaboxAlertChatOutput => ({
  kind: idempotencyKind === "recovered" ? "recovery" : kind,
  idempotencyKind,
  episodeStartedAt,
  alertKind: kind,
  validPhase: idempotencyKind === "recovered" ? "ok" : "alarm",
  threshold: idempotencyKind === "recovered" ? settings.recoverBitrateKbps : settings.lowBitrateKbps,
  seconds: idempotencyKind === "recovered" ? settings.recoverHoldSeconds : settings.holdSeconds,
});

const eligibleChat = (
  state: BelaboxAlertState,
  settings: BelaboxAlertSettings,
  now: number,
  successfulSample: boolean,
): BelaboxAlertChatOutput | null => {
  if (!successfulSample || !settings.chatEnabled || state.pendingChat === null) return null;
  const output = state.pendingChat;
  if (output.validPhase === "alarm" &&
      (state.phase !== "alarm" || state.kind !== output.alertKind || state.episodeStartedAt !== output.episodeStartedAt)) return null;
  if (output.validPhase === "ok" &&
      (state.phase !== "ok" || state.completedEpisodeAt !== output.episodeStartedAt)) return null;
  if (output.idempotencyKind !== "recovered" && state.lastChatSentAt !== null) {
    const lastSentAt = Date.parse(state.lastChatSentAt);
    if (Number.isFinite(lastSentAt) && now - lastSentAt < settings.chatCooldownSeconds * 1_000) return null;
  }
  return output;
};

const withChatOutput = (
  state: BelaboxAlertState,
  phaseChange: BelaboxAlertDiagnostic | null,
  settings: BelaboxAlertSettings,
  now: number,
  successfulSample: boolean,
): BelaboxAlertAdvance => ({
  state,
  outputs: { phaseChange, chat: eligibleChat(state, settings, now, successfulSample) },
});

/** Advances one alert episode using relay sample timestamps for both holds. */
export const advanceAlert = (
  state: BelaboxAlertState,
  sample: BelaboxAlertSample,
  settings: BelaboxAlertSettings,
  now: number,
): BelaboxAlertAdvance => {
  if (("kind" in sample && sample.kind === "stream_offline") || !settings.alertsEnabled) {
    return { state: createInitialAlertState(), outputs: { phaseChange: null, chat: null } };
  }
  if ("kind" in sample) {
    return withChatOutput(state, null, settings, now, false);
  }

  const relaySample = sample;
  const problem = failingKind(relaySample, settings);
  let next = state;
  let phaseChange: BelaboxAlertDiagnostic | null = null;

  if (state.phase === "ok") {
    if (problem !== null) {
      next = {
        ...state,
        phase: "pending",
        kind: problem,
        since: relaySample.at,
        episodeStartedAt: null,
        completedEpisodeAt: null,
        chatSentInEpisode: false,
        pendingChat: null,
      };
    }
  } else if (state.phase === "pending") {
    if (problem === null) {
      next = { ...state, phase: "ok", kind: null, since: null, episodeStartedAt: null, pendingChat: null };
    } else if (problem !== state.kind) {
      next = { ...state, kind: problem, since: relaySample.at };
    } else if (state.since !== null && (elapsedSeconds(state.since, relaySample.at) ?? -1) >= settings.holdSeconds) {
      const episodeStartedAt = state.since;
      const threshold = problem === "low" ? settings.lowBitrateKbps : 0;
      phaseChange = { code: "belabox.alert_started", detail: { kind: problem, threshold, seconds: settings.holdSeconds } };
      next = {
        ...state,
        phase: "alarm",
        episodeStartedAt,
        since: null,
        pendingChat: settings.chatEnabled
          ? pendingMessage(problem, "alert", episodeStartedAt, settings)
          : null,
      };
    }
  } else if (state.phase === "alarm") {
    if (state.kind === "low" && !relaySample.connected && state.episodeStartedAt !== null) {
      phaseChange = {
        code: "belabox.alert_escalated",
        detail: { kind: "disconnect", threshold: 0, seconds: settings.holdSeconds },
      };
      next = {
        ...state,
        kind: "disconnect",
        pendingChat: settings.chatEnabled
          ? pendingMessage("disconnect", "escalate", state.episodeStartedAt, settings)
          : null,
      };
    } else if (relaySample.connected && relaySample.bitrateKbps >= settings.recoverBitrateKbps) {
      next = { ...state, phase: "recovering", since: relaySample.at, pendingChat: null };
    }
  } else {
    if (problem !== null) {
      next = {
        ...state,
        phase: "alarm",
        kind: state.kind === "disconnect" ? "disconnect" : problem,
        since: null,
        pendingChat: null,
      };
    } else if (state.since !== null && (elapsedSeconds(state.since, relaySample.at) ?? -1) >= settings.recoverHoldSeconds &&
        state.episodeStartedAt !== null && state.kind !== null) {
      const episodeStartedAt = state.episodeStartedAt;
      phaseChange = {
        code: "belabox.alert_recovered",
        detail: { kind: state.kind, threshold: settings.recoverBitrateKbps, seconds: settings.recoverHoldSeconds },
      };
      next = {
        ...state,
        phase: "ok",
        kind: null,
        since: null,
        episodeStartedAt: null,
        completedEpisodeAt: episodeStartedAt,
        chatSentInEpisode: false,
        pendingChat: settings.chatEnabled && state.chatSentInEpisode
          ? pendingMessage(state.kind, "recovered", episodeStartedAt, settings)
          : null,
      };
    }
  }

  return withChatOutput(next, phaseChange, settings, now, true);
};

/** Applies the host chat result while preserving retryable output for the next poll. */
export const settleAlertChat = (
  state: BelaboxAlertState,
  result: { sent: boolean; retryable: boolean },
  now: number,
): BelaboxAlertState => {
  const output = state.pendingChat;
  if (output === null || (!result.sent && result.retryable)) return state;
  if (!result.sent) return { ...state, pendingChat: null };
  return {
    ...state,
    pendingChat: null,
    ...(output.idempotencyKind === "recovered"
      ? {}
      : { chatSentInEpisode: state.episodeStartedAt === output.episodeStartedAt, lastChatSentAt: new Date(now).toISOString() }),
  };
};
