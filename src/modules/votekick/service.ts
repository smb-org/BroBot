import { ballotChoiceFromMessage } from "../contract";
import type { BallotSnapshot, ModuleAction, ModuleAlarmContext, ModuleDiagnostic, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { formatTimeoutDuration, rollTimeoutSeconds } from "../contracts/moderation";
import { VOTEKICK_WINDOW_MS, votekickSettingsSchema, type Votekick, type VotekickSettings } from "./contracts";
import { canStartVotekick, isActiveVotekickTarget, votekickThreshold, votekickTimeoutReason, VOTEKICK_COMMAND_PATTERN, wasActiveBeforeVotekick } from "./domain";
import type { VotekickRepository, VotekickStart } from "./repository";

const emptyResult = (): ModuleResult => ({ actions: [], diagnostics: [] });
const textFromEvent = (event: ModuleEvent): string | null => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const text: unknown = Reflect.get(message, "text");
  return typeof text === "string" ? text : null;
};
const payloadString = (event: ModuleEvent, key: string): string | null => {
  const value = Reflect.get(event.payload, key);
  return typeof value === "string" && value.length > 0 ? value : null;
};
const rejection = (reason: string, target?: string): ModuleResult => ({
  actions: [],
  diagnostics: [{ code: "votekick.rejected", detail: { reason, ...(target === undefined ? {} : { target }) } }],
});

const chatAction = (text: string, target: VotekickSettings["chatTarget"], automated = false): ModuleAction | null =>
  text.length === 0 ? null : { kind: "chat", text, target, automated };

const renderChat = async (
  context: ModuleExecutionContext,
  template: string,
  values: Readonly<Record<string, string | number>>,
  target: VotekickSettings["chatTarget"],
): Promise<{ action: ModuleAction | null; diagnostics: readonly ModuleDiagnostic[]; attributions?: readonly string[] }> => {
  const rendered = await context.renderTemplate(template, values);
  return {
    action: chatAction(rendered.text, target),
    diagnostics: rendered.diagnostics,
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
  };
};

const finalizeRule = (running: Votekick) => ({
  passIf: { yes: 0, no: 1, netAtLeast: running.threshold },
});

const snapshotCounts = (snapshot: { counts: readonly number[] }): readonly [number, number] => [
  snapshot.counts[0] ?? 0,
  snapshot.counts[1] ?? 0,
];

type PassPreparation = {
  action: Extract<ModuleAction, { kind: "timeout" }>;
  diagnostics: readonly ModuleDiagnostic[];
};

const preparePass = async (
  running: Votekick,
  snapshot: BallotSnapshot,
  settings: VotekickSettings,
  language: "de" | "en",
  randomInteger: (maximumExclusive: number) => number,
  renderTemplate: (
    text: string,
    values: Readonly<Record<string, string | number>>,
  ) => Promise<{ text: string; diagnostics?: readonly ModuleDiagnostic[] }>,
): Promise<PassPreparation> => {
  const [yesVotes, noVotes] = snapshotCounts(snapshot);
  const durationSeconds = rollTimeoutSeconds(settings.duration, randomInteger);
  const duration = formatTimeoutDuration(durationSeconds, language);
  const values = {
    "votekick.target": running.targetLogin ?? running.targetUserId ?? "",
    "votekick.yes": yesVotes,
    "votekick.no": noVotes,
    "votekick.threshold": running.threshold,
    "votekick.seconds": durationSeconds,
    "votekick.duration": duration,
  };
  const [pass, fail] = await Promise.all([
    renderTemplate(settings.passText, values),
    renderTemplate(settings.failText, values),
  ]);
  return {
    action: {
      kind: "timeout",
      userId: running.targetUserId ?? "",
      durationSeconds,
      reason: votekickTimeoutReason(yesVotes, noVotes, running.id),
      ...(pass.text.length === 0 ? {} : { onSuccess: { kind: "chat", text: pass.text, target: settings.chatTarget, automated: false } }),
      ...(fail.text.length === 0 ? {} : { onFailure: { kind: "chat", text: fail.text, target: settings.chatTarget, automated: false } }),
    },
    diagnostics: [...(pass.diagnostics ?? []), ...(fail.diagnostics ?? [])],
  };
};

type VotekickFinalizeAccess = {
  ballots: ModuleExecutionContext["ballots"];
  channelLanguage: ModuleExecutionContext["channelLanguage"];
  secureRandomInteger: ModuleExecutionContext["secureRandomInteger"];
  renderTemplate: (
    text: string,
    values: Readonly<Record<string, string | number>>,
  ) => Promise<{ text: string; diagnostics?: readonly ModuleDiagnostic[] }>;
};

type VotekickFinalizeAttempt =
  | { outcome: "open" | "expired" | "not_open"; claimed: false }
  | { outcome: "passed"; claimed: boolean; prepared: PassPreparation };

const finalizeVotekick = async (
  channelId: string,
  running: Votekick,
  settings: VotekickSettings,
  repository: VotekickRepository,
  access: VotekickFinalizeAccess,
): Promise<VotekickFinalizeAttempt> => {
  const finalized = await access.ballots.finalize(running.id, finalizeRule(running));
  const [yesVotes, noVotes] = snapshotCounts(finalized);
  if (finalized.outcome === "open") {
    await repository.updateCounts(channelId, running.id, yesVotes, noVotes, finalized.revision);
    return { outcome: "open", claimed: false };
  }
  if (finalized.outcome === "not_open") {
    const endedAt = new Date().toISOString();
    const resolved = await repository.finalize(
      channelId, running.id, "expired", running.yesVotes, running.noVotes, running.ballotRevision, null, endedAt,
    );
    if (resolved) return { outcome: "expired", claimed: false };
    const current = await repository.byId(channelId, running.id);
    if (current?.status === "expired") return { outcome: "expired", claimed: false };
    if (current?.status === "running") throw new Error("Missing votekick ballot could not be resolved in D1.");
    return { outcome: "not_open", claimed: false };
  }
  if (finalized.outcome === "expired") {
    const resolved = await repository.finalize(
      channelId, running.id, "expired", yesVotes, noVotes, finalized.revision, null, new Date().toISOString(),
    );
    if (resolved) return { outcome: "expired", claimed: false };
    const current = await repository.byId(channelId, running.id);
    if (current?.status === "expired") return { outcome: "expired", claimed: false };
    if (current?.status === "running") throw new Error("Expired votekick ballot could not be resolved in D1.");
    return { outcome: "not_open", claimed: false };
  }
  // Preparing before the conditional D1 update leaves a finalized DO pass retryable on failure.
  const prepared = await preparePass(
    running,
    { counts: finalized.counts, revision: finalized.revision },
    settings,
    await access.channelLanguage(),
    access.secureRandomInteger,
    access.renderTemplate,
  );
  const claimed = await repository.finalize(
    channelId,
    running.id,
    "passed",
    yesVotes,
    noVotes,
    finalized.revision,
    prepared.action.durationSeconds,
    new Date().toISOString(),
  );
  return { outcome: "passed", claimed, prepared };
};

const bestEffortClose = async (context: ModuleExecutionContext, id: string): Promise<void> => {
  try {
    const snapshot = await context.ballots.close(id);
    if (snapshot !== null) await context.ballots.acknowledgeClosed?.(id);
  } catch { /* The host hard-delete alarm is the cleanup fallback. */ }
};

const bestEffortCloseAlarm = async (context: Pick<ModuleAlarmContext, "ballots">, id: string): Promise<void> => {
  try {
    const snapshot = await context.ballots.close(id);
    if (snapshot !== null) await context.ballots.acknowledgeClosed?.(id);
  } catch { /* The host hard-delete alarm is the cleanup fallback. */ }
};

const bestEffortClear = async (context: ModuleExecutionContext, alarmKey: string): Promise<void> => {
  try { await context.clearAlarm(alarmKey); } catch { /* The alarm is idempotent and can clean up a stale key. */ }
};

const commandResult = async (
  event: ModuleEvent<VotekickSettings>,
  repository: VotekickRepository,
  context: ModuleExecutionContext,
  login: string,
): Promise<ModuleResult> => {
  let ballotOpened = false;
  let alarmScheduled = false;
  let admissionAttempted = false;
  let start: VotekickStart | null = null;
  let id: string | null = null;
  const reject = (reason: string, target?: string, includeProtectedText = false, displayTarget = login): Promise<ModuleResult> => {
    if (!includeProtectedText) return Promise.resolve(rejection(reason, target));
    return renderChat(context, event.settings.protectedText, {
      "votekick.target": displayTarget,
      "votekick.yes": 0,
      "votekick.no": 0,
      "votekick.threshold": event.settings.minNetVotes,
      "votekick.seconds": 0,
      "votekick.duration": "",
    }, event.settings.chatTarget).then(({ action, diagnostics, attributions }) => ({
      actions: action === null ? [] : [action],
      diagnostics: [...diagnostics, { code: "votekick.rejected", detail: { reason, ...(target === undefined ? {} : { target }) } }],
      ...(attributions === undefined ? {} : { attributions }),
    }));
  };

  try {
    const streamState = await context.streamState();
    if (streamState !== "online") return await reject("stream_not_online");
    if (context.lookupUserByLogin === undefined) return await reject("lookup_failure");
    const lookup = await context.lookupUserByLogin(login.toLowerCase());
    if (lookup === null) return await reject("target_unresolvable", login.toLowerCase());
    const botUserId = await context.botUserId?.();
    if (botUserId === null || botUserId === undefined) return await reject("lookup_failure", lookup.userId);
    if (lookup.userId === botUserId || lookup.userId === event.channelId) {
      return await reject("target_protected", lookup.userId, true, lookup.login);
    }
    if (context.isChannelModerator === undefined) return await reject("lookup_failure", lookup.userId);
    const moderator = await context.isChannelModerator(lookup.userId);
    if (moderator === null) return await reject("lookup_failure", lookup.userId);
    if (moderator) return await reject("target_protected", lookup.userId, true, lookup.login);
    const nowMs = Date.now();
    const activity = await context.activeChatters.seen(lookup.userId);
    if (!isActiveVotekickTarget(activity?.lastSeenAt ?? null, nowMs, VOTEKICK_WINDOW_MS)) {
      return await reject("target_not_active", lookup.userId);
    }

    const activeCount = await context.activeChatters.count(VOTEKICK_WINDOW_MS);
    const threshold = votekickThreshold(event.settings.minNetVotes, event.settings.percent, activeCount);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const endsAtMs = startedAtMs + event.settings.windowSeconds * 1000;
    const endsAt = new Date(endsAtMs).toISOString();
    id = crypto.randomUUID();
    const startMessage = await renderChat(context, event.settings.startText, {
      "votekick.target": lookup.login,
      "votekick.yes": 1,
      "votekick.no": 0,
      "votekick.threshold": threshold,
      "votekick.seconds": 0,
      "votekick.duration": "",
    }, event.settings.chatTarget);

    // Register this first so the module can snapshot and close the ballot before its own expiry alarm.
    await context.scheduleAlarm("close", `close:${id}`, endsAtMs);
    alarmScheduled = true;
    const opened = await context.ballots.open(id, 2, endsAtMs);
    if (opened.status === "busy") {
      await bestEffortClear(context, `close:${id}`);
      const busy = await renderChat(context, event.settings.busyText, {
        "votekick.target": lookup.login,
        "votekick.yes": 0,
        "votekick.no": 0,
        "votekick.threshold": threshold,
        "votekick.seconds": 0,
        "votekick.duration": "",
      }, event.settings.chatTarget);
      return {
        actions: busy.action === null ? [] : [busy.action],
        diagnostics: [...busy.diagnostics, ...rejection("busy").diagnostics],
        ...(busy.attributions === undefined ? {} : { attributions: busy.attributions }),
      };
    }
    ballotOpened = true;

    const starterVote = await context.ballots.cast(id, payloadString(event, "chatter_user_id") ?? "", 1);
    if (starterVote.status !== "counted") {
      await bestEffortClose(context, id);
      ballotOpened = false;
      await bestEffortClear(context, `close:${id}`);
      alarmScheduled = false;
      return await reject("lookup_failure", lookup.userId);
    }

    start = {
      id,
      targetUserId: lookup.userId,
      targetLogin: lookup.login,
      initiatorUserId: payloadString(event, "chatter_user_id") ?? "",
      threshold,
      yesVotes: starterVote.counts[0] ?? 1,
      ballotRevision: starterVote.revision,
      startedAt,
      endsAt,
    };
    admissionAttempted = true;
    const admitted = await repository.admit(
      event.channelId,
      start,
      new Date().toISOString(),
      event.settings.channelCooldownSeconds,
      event.settings.targetCooldownSeconds,
    );
    if (admitted !== "admitted") {
      await bestEffortClose(context, id);
      await bestEffortClear(context, `close:${id}`);
      ballotOpened = false;
      alarmScheduled = false;
      if (admitted === "busy") {
        const busy = await renderChat(context, event.settings.busyText, {
          "votekick.target": lookup.login,
          "votekick.yes": 0,
          "votekick.no": 0,
          "votekick.threshold": threshold,
          "votekick.seconds": 0,
          "votekick.duration": "",
        }, event.settings.chatTarget);
        return {
          actions: busy.action === null ? [] : [busy.action],
          diagnostics: [...busy.diagnostics, ...rejection("busy").diagnostics],
          ...(busy.attributions === undefined ? {} : { attributions: busy.attributions }),
        };
      }
      return await reject(admitted, lookup.userId);
    }
    ballotOpened = false;
    alarmScheduled = false;
    return {
      actions: startMessage.action === null ? [] : [startMessage.action],
      diagnostics: startMessage.diagnostics,
      ...(startMessage.attributions === undefined ? {} : { attributions: startMessage.attributions }),
    };
  } catch {
    // If D1's admission response was ambiguous, end any row that may have committed before cleanup.
    let admissionRollbackConfirmed = false;
    if (admissionAttempted && start !== null) {
      try {
        admissionRollbackConfirmed = await repository.finish(
          event.channelId, start.id, "failed", start.yesVotes, 0, start.ballotRevision, null, new Date().toISOString(),
        );
      } catch { /* The persisted expiry and module alarm recover an uncertain admission. */ }
    }
    if (ballotOpened && id !== null) await bestEffortClose(context, id);
    if (alarmScheduled && id !== null && (!admissionAttempted || admissionRollbackConfirmed)) {
      await bestEffortClear(context, `close:${id}`);
    }
    return rejection("lookup_failure");
  }
};

export const processVotekickMessage = async (
  event: ModuleEvent<VotekickSettings>,
  repository: VotekickRepository,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return emptyResult();
  const text = textFromEvent(event);
  if (text === null) return emptyResult();
  const starterId = payloadString(event, "chatter_user_id");
  if (starterId === null || starterId === await context.botUserId?.()) return emptyResult();
  const command = VOTEKICK_COMMAND_PATTERN.exec(text.trim());
  const choice = ballotChoiceFromMessage(text, 2);

  const finishAttempt = async (running: Votekick, attempt: VotekickFinalizeAttempt): Promise<ModuleResult | null> => {
    if (attempt.outcome === "passed") {
      if (!attempt.claimed) return emptyResult();
      await bestEffortClose(context, running.id);
      await bestEffortClear(context, `close:${running.id}`);
      return { actions: [attempt.prepared.action], diagnostics: [...attempt.prepared.diagnostics] };
    }
    if (attempt.outcome === "expired") {
      await bestEffortClose(context, running.id);
      if (event.settings.expiredText.length === 0) await bestEffortClear(context, `close:${running.id}`);
      else await context.scheduleAlarm("close", `close:${running.id}`, Date.now());
      return emptyResult();
    }
    return null;
  };

  const current = await repository.running(event.channelId);
  if (current !== null) {
    const attempt = await finalizeVotekick(event.channelId, current, event.settings, repository, context);
    const completed = await finishAttempt(current, attempt);
    if (completed !== null) return completed;
    if (attempt.outcome === "not_open") return emptyResult();
  }

  if (command !== null) {
    if (!canStartVotekick(event.chatStatus)) return rejection("starter_not_authorized");
    return commandResult(event, repository, context, command[1] ?? "");
  }

  if (choice === null) return emptyResult();
  if (current === null || current.targetUserId === null || current.initiatorUserId === null) return emptyResult();
  const messageAt = Date.parse(event.eventSubTimestamp ?? "");
  const startedAt = Date.parse(current.startedAt);
  const endsAt = Date.parse(current.endsAt);
  if (!Number.isFinite(messageAt) || !Number.isFinite(startedAt) || !Number.isFinite(endsAt) ||
      messageAt < startedAt || messageAt > endsAt) return emptyResult();
  const activity = await context.activeChatters.seen(starterId);
  if (starterId !== current.initiatorUserId && !wasActiveBeforeVotekick(activity?.firstSeenAt ?? null, current.startedAt)) return emptyResult();
  await context.ballots.cast(current.id, starterId, choice);
  const attempt = await finalizeVotekick(event.channelId, current, event.settings, repository, context);
  return await finishAttempt(current, attempt) ?? emptyResult();
};

export const closeExpiredVotekick = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  repository: VotekickRepository,
): Promise<void> => {
  const id = alarmKey.startsWith("close:") ? alarmKey.slice("close:".length) : "";
  if (id.length === 0) return;
  let running = await repository.byId(context.channelId, id);
  if (running === null) {
    await bestEffortCloseAlarm(context, id);
    try { await context.clear(`close:${id}`); } catch { /* The ballot hard-delete alarm is independent. */ }
    return;
  }
  if (running.status === "running") {
    const stored = await context.DB.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?")
      .bind(context.channelId, "votekick").first<{ settings: string }>();
    if (stored === null) throw new Error("Votekick settings are unavailable while finalizing its ballot.");
    const settings = votekickSettingsSchema.parse(JSON.parse(stored.settings));
    const attempt = await finalizeVotekick(context.channelId, running, settings, repository, context);
    if (attempt.outcome === "open") {
      const expiresAt = Date.parse(running.endsAt);
      if (Number.isFinite(expiresAt)) await context.schedule(`close:${id}`, expiresAt);
      return;
    }
    if (attempt.outcome === "passed") {
      if (!attempt.claimed) {
        const current = await repository.byId(context.channelId, id);
        if (current?.status === "running") throw new Error("Finalized votekick pass is waiting for its D1 claim.");
        await bestEffortCloseAlarm(context, id);
        try { await context.clear(`close:${id}`); } catch { /* A stale alarm observes the terminal D1 row. */ }
        return;
      }
      try {
        const outcome = await context.executeTimeout(attempt.prepared.action);
        const followUp = outcome === "applied" ? attempt.prepared.action.onSuccess
          : outcome === "rejected" ? attempt.prepared.action.onFailure
            : undefined;
        if (followUp?.kind === "chat" && followUp.text.length > 0) {
          const delivery = await context.sendChat(
            followUp.text,
            `votekick:${id}:passed:${outcome}`,
            undefined,
            async () => (await repository.byId(context.channelId, id))?.status === "passed",
            followUp.target === "where_asked" ? settings.chatTarget : followUp.target ?? settings.chatTarget,
          );
          if (!delivery.sent && delivery.retryable) throw new Error(`Votekick pass follow-up failed: ${delivery.reason ?? "unknown"}.`);
        }
      } finally {
        await bestEffortCloseAlarm(context, id);
        try { await context.clear(`close:${id}`); } catch { /* The host hard-delete alarm is independent. */ }
      }
      return;
    }
    if (attempt.outcome === "not_open") {
      const current = await repository.byId(context.channelId, id);
      if (current?.status === "running") throw new Error("Votekick ballot is missing while its D1 row is still running.");
      if (current?.status !== "expired") {
        await bestEffortCloseAlarm(context, id);
        try { await context.clear(`close:${id}`); } catch { /* The row is no longer unresolved. */ }
        return;
      }
      running = current;
    } else {
      running = await repository.byId(context.channelId, id);
    }
  }
  if (running?.status !== "expired") return;

  const stored = await context.DB.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?")
    .bind(context.channelId, "votekick").first<{ settings: string }>();
  if (stored === null) {
    await bestEffortCloseAlarm(context, id);
    try { await context.clear(`close:${id}`); } catch { /* A stale alarm observes the terminal D1 row. */ }
    return;
  }
  const settings = votekickSettingsSchema.parse(JSON.parse(stored.settings));
  if (settings.expiredText.length === 0) {
    await bestEffortCloseAlarm(context, id);
    try { await context.clear(`close:${id}`); } catch { /* A stale alarm observes the terminal D1 row. */ }
    return;
  }
  const rendered = await context.renderTemplate(settings.expiredText, {
    "votekick.target": running.targetLogin ?? running.targetUserId ?? "",
    "votekick.yes": running.yesVotes,
    "votekick.no": running.noVotes,
    "votekick.threshold": running.threshold,
    "votekick.seconds": 0,
    "votekick.duration": "",
  }, Date.parse(running.endedAt ?? running.endsAt));
  if (rendered.text.length > 0) {
    const result = await context.sendChat(rendered.text, `votekick:${id}:expired`, rendered.attributions, async () =>
      (await repository.byId(context.channelId, id))?.status === "expired", settings.chatTarget);
    if (!result.sent && result.retryable) throw new Error(`Votekick expiry chat failed: ${result.reason ?? "unknown"}.`);
  }
  await bestEffortCloseAlarm(context, id);
  try { await context.clear(`close:${id}`); } catch { /* A stale alarm observes the terminal D1 row. */ }
};
