import { ballotChoiceFromMessage } from "../contract";
import type { ModuleAction, ModuleAlarmContext, ModuleDiagnostic, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { formatTimeoutDuration, rollTimeoutSeconds } from "../contracts/moderation";
import { VOTEKICK_WINDOW_MS, votekickSettingsSchema, type VotekickSettings } from "./contracts";
import { canStartVotekick, isActiveVotekickTarget, votekickThreshold, votekickTimeoutReason, VOTEKICK_COMMAND_PATTERN, wasActiveBeforeVotekick } from "./domain";
import type { VotekickRepository } from "./repository";

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

const commandResult = async (
  event: ModuleEvent<VotekickSettings>,
  repository: VotekickRepository,
  context: ModuleExecutionContext,
  login: string,
): Promise<ModuleResult> => {
  let ballotForCleanup: string | null = null;
  let runningRowStored = false;
  const reject = (reason: string, target?: string, includeProtectedText = false, displayTarget = login): Promise<ModuleResult> => {
    if (!includeProtectedText) return Promise.resolve(rejection(reason, target));
    return renderChat(context, event.settings.protectedText, {
      "votekick.target": displayTarget,
      "votekick.yes": 0,
      "votekick.no": 0,
      "votekick.threshold": event.settings.minNetVotes,
      "votekick.seconds": 0,
      "votekick.duration": "",
    }, event.settings.chatTarget).then(({ action, diagnostics }) => ({
      actions: action === null ? [] : [action],
      diagnostics: [...diagnostics, { code: "votekick.rejected", detail: { reason, ...(target === undefined ? {} : { target }) } }],
    }));
  };

  let streamState;
  try { streamState = await context.streamState(); }
  catch { return reject("lookup_failure"); }
  if (streamState !== "online") return reject("stream_not_online");

  try {
    const channelEndedAt = await repository.channelEndedAt(event.channelId);
    if (channelEndedAt !== null) {
      const endedAt = Date.parse(channelEndedAt);
      if (!Number.isFinite(endedAt)) return await reject("lookup_failure");
      if (Date.now() - endedAt < event.settings.channelCooldownSeconds * 1000) return await reject("channel_cooldown");
    }
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
    const targetStartedAt = await repository.targetStartedAt(event.channelId, lookup.userId);
    if (targetStartedAt !== null) {
      const startedAt = Date.parse(targetStartedAt);
      if (!Number.isFinite(startedAt)) return await reject("lookup_failure", lookup.userId);
      if (nowMs - startedAt < event.settings.targetCooldownSeconds * 1000) return await reject("target_cooldown", lookup.userId);
    }
    const activity = await context.activeChatters.seen(lookup.userId);
    if (!isActiveVotekickTarget(activity?.lastSeenAt ?? null, nowMs, VOTEKICK_WINDOW_MS)) return await reject("target_not_active", lookup.userId);

    const activeCount = await context.activeChatters.count(VOTEKICK_WINDOW_MS);
    const threshold = votekickThreshold(event.settings.minNetVotes, event.settings.percent, activeCount);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const endsAtMs = startedAtMs + event.settings.windowSeconds * 1000;
    const endsAt = new Date(endsAtMs).toISOString();
    const id = crypto.randomUUID();
    const opened = await context.ballots.open(id, 2, endsAtMs);
    if (opened.status === "busy") {
      const busy = await renderChat(context, event.settings.busyText, {
        "votekick.target": lookup.login,
        "votekick.yes": 0,
        "votekick.no": 0,
        "votekick.threshold": threshold,
        "votekick.seconds": 0,
        "votekick.duration": "",
      }, event.settings.chatTarget);
      return { actions: busy.action === null ? [] : [busy.action], diagnostics: [...busy.diagnostics, ...rejection("busy").diagnostics] };
    }
    ballotForCleanup = id;

    const starterVote = await context.ballots.cast(id, payloadString(event, "chatter_user_id") ?? "", 1);
    if (starterVote.status !== "counted") {
      await context.ballots.close(id);
      return await reject("lookup_failure", lookup.userId);
    }
    const inserted = await repository.insertRunning(event.channelId, {
      id,
      targetUserId: lookup.userId,
      targetLogin: lookup.login,
      initiatorUserId: payloadString(event, "chatter_user_id") ?? "",
      threshold,
      startedAt,
      endsAt,
    });
    if (!inserted) {
      await context.ballots.close(id);
      const busy = await renderChat(context, event.settings.busyText, {
        "votekick.target": lookup.login,
        "votekick.yes": 0,
        "votekick.no": 0,
        "votekick.threshold": threshold,
        "votekick.seconds": 0,
        "votekick.duration": "",
      }, event.settings.chatTarget);
      return { actions: busy.action === null ? [] : [busy.action], diagnostics: [...busy.diagnostics, ...rejection("busy").diagnostics] };
    }
    runningRowStored = true;
    try {
      await context.scheduleAlarm("close", `close:${id}`, endsAtMs);
    } catch {
      await context.ballots.close(id);
      await repository.finish(event.channelId, id, "failed", 1, 0, null, new Date().toISOString());
      return await reject("lookup_failure", lookup.userId);
    }
    const start = await renderChat(context, event.settings.startText, {
      "votekick.target": lookup.login,
      "votekick.yes": starterVote.counts[0] ?? 1,
      "votekick.no": starterVote.counts[1] ?? 0,
      "votekick.threshold": threshold,
      "votekick.seconds": 0,
      "votekick.duration": "",
    }, event.settings.chatTarget);
    return { actions: start.action === null ? [] : [start.action], diagnostics: start.diagnostics };
  } catch {
    if (ballotForCleanup !== null && !runningRowStored) {
      try { await context.ballots.close(ballotForCleanup); } catch { /* The host expires an orphaned ballot on its alarm. */ }
    }
    return await reject("lookup_failure");
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
    if (!canStartVotekick(event.chatStatus)) return rejection("starter_not_authorized");
    return commandResult(event, repository, context, command[1] ?? "");
  }

  const choice = ballotChoiceFromMessage(text, 2);
  if (choice === null) return emptyResult();
  const running = await repository.running(event.channelId);
  if (running === null || running.targetUserId === null || running.initiatorUserId === null) return emptyResult();
  const activity = await context.activeChatters.seen(starterId);
  if (starterId !== running.initiatorUserId && !wasActiveBeforeVotekick(activity?.firstSeenAt ?? null, running.startedAt)) return emptyResult();
  const result = await context.ballots.cast(running.id, starterId, choice);
  if (result.status === "not_open") return emptyResult();
  const yesVotes = result.counts[0] ?? 0;
  const noVotes = result.counts[1] ?? 0;
  await repository.updateCounts(event.channelId, running.id, yesVotes, noVotes);
  if (yesVotes - noVotes < running.threshold) return emptyResult();

  const closed = await context.ballots.close(running.id);
  if (closed === null) return emptyResult();
  const finalYes = closed.counts[0] ?? 0;
  const finalNo = closed.counts[1] ?? 0;
  const passed = finalYes - finalNo >= running.threshold;
  const durationSeconds = passed ? rollTimeoutSeconds(event.settings.duration, context.secureRandomInteger) : null;
  const endedAt = new Date().toISOString();
  const stored = await repository.finish(event.channelId, running.id, passed ? "passed" : "expired", finalYes, finalNo, durationSeconds, endedAt);
  await context.clearAlarm(`close:${running.id}`);
  if (!stored || !passed || durationSeconds === null) return emptyResult();

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
  const target = event.settings.chatTarget;
  const action: ModuleAction = {
    kind: "timeout",
    userId: running.targetUserId,
    durationSeconds,
    reason: votekickTimeoutReason(finalYes, finalNo, running.id),
    ...(pass.text.length === 0 ? {} : { onSuccess: { kind: "chat", text: pass.text, target, automated: false } }),
    ...(fail.text.length === 0 ? {} : { onFailure: { kind: "chat", text: fail.text, target, automated: false } }),
  };
  return { actions: [action], diagnostics: [...pass.diagnostics, ...fail.diagnostics] };
};

export const closeExpiredVotekick = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  repository: VotekickRepository,
): Promise<void> => {
  const id = alarmKey.startsWith("close:") ? alarmKey.slice("close:".length) : "";
  if (id.length === 0) return;
  const running = await repository.running(context.channelId);
  if (running === null || running.id !== id) {
    await context.ballots.close(id);
    return;
  }
  const closed = await context.ballots.close(id);
  const yesVotes = closed?.counts[0] ?? running.yesVotes;
  const noVotes = closed?.counts[1] ?? running.noVotes;
  const endedAt = new Date().toISOString();
  const finished = await repository.finish(context.channelId, id, "expired", yesVotes, noVotes, null, endedAt);
  if (!finished) return;

  let settings: VotekickSettings;
  try {
    const stored = await context.DB.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?")
      .bind(context.channelId, "votekick").first<{ settings: string }>();
    if (stored === null) return;
    settings = votekickSettingsSchema.parse(JSON.parse(stored.settings));
  } catch {
    return;
  }
  if (settings.expiredText.length === 0) return;
  const values = {
    "votekick.target": running.targetLogin ?? running.targetUserId ?? "",
    "votekick.yes": yesVotes,
    "votekick.no": noVotes,
    "votekick.threshold": running.threshold,
    "votekick.seconds": 0,
    "votekick.duration": "",
  };
  const rendered = await context.renderTemplate(settings.expiredText, values, Date.parse(endedAt));
  const result = await context.sendChat(rendered.text, `votekick:${id}:expired`, rendered.attributions, async () => {
    const current = await context.DB.prepare("SELECT status FROM votekicks WHERE channel_id = ? AND votekick_id = ?")
      .bind(context.channelId, id).first<{ status: string }>();
    return current?.status === "expired";
  }, settings.chatTarget);
  if (!result.sent && result.retryable) throw new Error(`Votekick expiry chat failed: ${result.reason ?? "unknown"}.`);
};
