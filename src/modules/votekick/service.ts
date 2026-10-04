import { ballotChoiceFromMessage } from "../contract";
import type { ModuleAction, ModuleAlarmContext, ModuleBallotAccess, ModuleDiagnostic, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
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

/** D1 owns expiry; ballot closure is only cleanup and can never block the status transition. */
const recoverOverdue = async (
  context: { channelId: string; ballots: ModuleBallotAccess },
  repository: VotekickRepository,
  now: string,
): Promise<readonly Votekick[]> => {
  const expired = await repository.expireOverdue(context.channelId, now);
  await Promise.all(expired.map(async (row) => {
    try {
      const snapshot = await context.ballots.close(row.id);
      if (snapshot !== null) {
        await repository.updateCounts(context.channelId, row.id, snapshot.counts[0] ?? 0, snapshot.counts[1] ?? 0, snapshot.revision);
      }
    } catch {
      // The ballot's own expiry alarm removes it if cleanup is unavailable.
    }
  }));
  return expired;
};

const bestEffortClose = async (context: ModuleExecutionContext, id: string): Promise<void> => {
  try { await context.ballots.close(id); } catch { /* Its own expiry alarm is the cleanup fallback. */ }
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
  if (command !== null) {
    try { await recoverOverdue({ channelId: event.channelId, ballots: context.ballots }, repository, new Date().toISOString()); }
    catch { return rejection("lookup_failure"); }
    if (!canStartVotekick(event.chatStatus)) return rejection("starter_not_authorized");
    return commandResult(event, repository, context, command[1] ?? "");
  }

  const choice = ballotChoiceFromMessage(text, 2);
  if (choice === null) return emptyResult();
  try { await recoverOverdue({ channelId: event.channelId, ballots: context.ballots }, repository, new Date().toISOString()); }
  catch { return emptyResult(); }
  const running = await repository.running(event.channelId);
  if (running === null || running.targetUserId === null || running.initiatorUserId === null) return emptyResult();
  const messageAt = Date.parse(event.eventSubTimestamp ?? "");
  const startedAt = Date.parse(running.startedAt);
  const endsAt = Date.parse(running.endsAt);
  if (!Number.isFinite(messageAt) || !Number.isFinite(startedAt) || !Number.isFinite(endsAt) ||
      messageAt < startedAt || messageAt > endsAt) return emptyResult();
  const activity = await context.activeChatters.seen(starterId);
  if (starterId !== running.initiatorUserId && !wasActiveBeforeVotekick(activity?.firstSeenAt ?? null, running.startedAt)) return emptyResult();
  const result = await context.ballots.cast(running.id, starterId, choice);
  if (result.status === "not_open") return emptyResult();
  const yesVotes = result.counts[0] ?? 0;
  const noVotes = result.counts[1] ?? 0;
  await repository.updateCounts(event.channelId, running.id, yesVotes, noVotes, result.revision);

  let snapshot = await context.ballots.read(running.id);
  while (snapshot !== null) {
    const finalYes = snapshot.counts[0] ?? 0;
    const finalNo = snapshot.counts[1] ?? 0;
    await repository.updateCounts(event.channelId, running.id, finalYes, finalNo, snapshot.revision);
    if (finalYes - finalNo < running.threshold) return emptyResult();

    const durationSeconds = rollTimeoutSeconds(event.settings.duration, context.secureRandomInteger);
    const duration = formatTimeoutDuration(durationSeconds, await context.channelLanguage());
    const values = {
      "votekick.target": running.targetLogin ?? running.targetUserId,
      "votekick.yes": finalYes,
      "votekick.no": finalNo,
      "votekick.threshold": running.threshold,
      "votekick.seconds": durationSeconds,
      "votekick.duration": duration,
    };
    const [pass, fail] = await Promise.all([
      context.renderTemplate(event.settings.passText, values),
      context.renderTemplate(event.settings.failText, values),
    ]);
    const action: ModuleAction = {
      kind: "timeout",
      userId: running.targetUserId,
      durationSeconds,
      reason: votekickTimeoutReason(finalYes, finalNo, running.id),
      ...(pass.text.length === 0 ? {} : { onSuccess: { kind: "chat", text: pass.text, target: event.settings.chatTarget, automated: false } }),
      ...(fail.text.length === 0 ? {} : { onFailure: { kind: "chat", text: fail.text, target: event.settings.chatTarget, automated: false } }),
    };

    // Preparation can yield while another voter changes the ballot. Re-read
    // before claiming so the timeout is built from the latest stable snapshot.
    const latest = await context.ballots.read(running.id);
    if (latest === null) return emptyResult();
    if (latest.revision !== snapshot.revision) {
      snapshot = latest;
      continue;
    }

    const stored = await repository.finish(
      event.channelId, running.id, "passed", finalYes, finalNo, snapshot.revision, durationSeconds, new Date().toISOString(),
    );
    if (!stored) return emptyResult();
    await bestEffortClose(context, running.id);
    try { await context.clearAlarm(`close:${running.id}`); } catch { /* A stale expiry alarm sees the passed row and exits. */ }
    return { actions: [action], diagnostics: [...pass.diagnostics, ...fail.diagnostics] };
  }
  return emptyResult();
};

export const closeExpiredVotekick = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  repository: VotekickRepository,
): Promise<void> => {
  const id = alarmKey.startsWith("close:") ? alarmKey.slice("close:".length) : "";
  if (id.length === 0) return;
  const now = new Date().toISOString();
  const finalized = await recoverOverdue(context, repository, now);
  let running = await repository.byId(context.channelId, id);
  if (running === null) {
    try { await context.ballots.close(id); } catch { /* No D1 row remains; the ballot expires on its own. */ }
    return;
  }
  if (running.status === "running") {
    const expiresAt = Date.parse(running.endsAt);
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      await context.schedule(`close:${id}`, expiresAt);
      return;
    }
    await repository.expireOverdue(context.channelId, now);
    running = await repository.byId(context.channelId, id);
  }
  if (running?.status !== "expired") return;

  if (!finalized.some((row) => row.id === id)) {
    try {
      const snapshot = await context.ballots.close(id);
      if (snapshot !== null) {
        await repository.updateCounts(context.channelId, id, snapshot.counts[0] ?? 0, snapshot.counts[1] ?? 0, snapshot.revision);
        running = await repository.byId(context.channelId, id);
      }
    } catch {
      // Expiry is committed in D1 already; persisted revision-guarded counts are the fallback.
    }
  } else {
    running = await repository.byId(context.channelId, id);
  }
  if (running === null || running.status !== "expired") return;

  const stored = await context.DB.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?")
    .bind(context.channelId, "votekick").first<{ settings: string }>();
  if (stored === null) return;
  const settings = votekickSettingsSchema.parse(JSON.parse(stored.settings));
  if (settings.expiredText.length === 0) return;
  const rendered = await context.renderTemplate(settings.expiredText, {
    "votekick.target": running.targetLogin ?? running.targetUserId ?? "",
    "votekick.yes": running.yesVotes,
    "votekick.no": running.noVotes,
    "votekick.threshold": running.threshold,
    "votekick.seconds": 0,
    "votekick.duration": "",
  }, Date.parse(running.endedAt ?? running.endsAt));
  const result = await context.sendChat(rendered.text, `votekick:${id}:expired`, rendered.attributions, async () =>
    (await repository.byId(context.channelId, id))?.status === "expired", settings.chatTarget);
  if (!result.sent && result.retryable) throw new Error(`Votekick expiry chat failed: ${result.reason ?? "unknown"}.`);
};
