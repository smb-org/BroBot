import { ballotChoiceFromMessage, type ModuleEvent, type ModuleExecutionContext, type ModuleMutationAuthorization, type ModuleResult } from "../contract";
import type { ModuleLanguage, ModuleAlarmContext } from "../contract";
import { CHAT_VOTING_ALARM_HANDLER, CHAT_VOTING_BALLOT_RETENTION_MS, CHAT_VOTING_ELEMENT_KIND, CHAT_VOTING_MODULE_ID, DEFAULT_CHAT_VOTING_SETTINGS, chatVotingSettingsSchema } from "./contracts";
import type { ChatVote, ChatVoteDraft, ChatVotePreset, ChatVotingSettings } from "./contracts";
import { formatVoteResult, labelsForVote, parseVoteCommand, voteCloseDeadline } from "./domain";
import type { ChatVotingRepository } from "./repository";
import { chatVotingChatText } from "./contracts/chat-defaults";
import { createChatVotingRepository } from "./repository";

export interface StartChatVoteInput {
  channelId: string;
  preset: ChatVotePreset;
  optionCount: number;
  settings: ChatVotingSettings;
  language: ModuleLanguage;
  openedAt?: number;
  authorization?: ModuleMutationAuthorization;
}

export type VoteStartResult =
  | { status: "started"; vote: ChatVoteDraft }
  | { status: "busy" };

export const startChatVote = async (
  repository: ChatVotingRepository,
  input: StartChatVoteInput,
  ballots: ModuleExecutionContext["ballots"],
  scheduleClose: (pollId: string, deadline: number, ownerRevision: number) => Promise<void>,
): Promise<VoteStartResult> => {
  if (!Number.isInteger(input.optionCount) || input.optionCount < 2 || input.optionCount > 9 ||
      input.preset === "yes_no" && input.optionCount !== 2 ||
      input.preset === "scale_5" && input.optionCount !== 5) {
    throw new RangeError("The selected voting preset has an invalid option count.");
  }
  const requestedOpenedAt = input.openedAt ?? Date.now();
  const latestVote = await repository.latest(input.channelId);
  const latestOpenedAt = latestVote === null ? Number.NaN : Date.parse(latestVote.openedAt);
  const openedAt = Number.isFinite(latestOpenedAt)
    ? Math.max(requestedOpenedAt, latestOpenedAt + 1)
    : requestedOpenedAt;
  const deadline = voteCloseDeadline(openedAt, input.settings.autoCloseSeconds);
  const vote: ChatVoteDraft = {
    id: crypto.randomUUID(),
    channelId: input.channelId,
    preset: input.preset,
    optionCount: input.optionCount,
    labels: labelsForVote(input.settings, input.preset, input.optionCount, input.language),
    openedAt: new Date(openedAt).toISOString(),
    closesAt: new Date(deadline.closesAt).toISOString(),
    closeReason: deadline.reason,
    status: "open",
  };
  const opened = await ballots.open(
    vote.id,
    vote.optionCount,
    openedAt + CHAT_VOTING_BALLOT_RETENTION_MS,
  );
  if (opened.status === "busy") return { status: "busy" };

  let inserted = false;
  try {
    inserted = await repository.insertOpen(vote, input.authorization);
    if (!inserted) {
      await ballots.close(vote.id);
      await ballots.acknowledgeClosed?.(vote.id);
      return { status: "busy" };
    }
    await scheduleClose(vote.id, deadline.closesAt, 0);
  } catch (error: unknown) {
    const closedSnapshot = await ballots.close(vote.id).catch(() => null);
    if (inserted) {
      const finished = await repository.finish(
        input.channelId,
        vote.id,
        vote.closeReason,
        new Date().toISOString(),
        Array.from({ length: vote.optionCount }, () => 0),
      ).catch(() => false);
      if (finished) await ballots.acknowledgeClosed?.(vote.id).catch(() => null);
    } else if (closedSnapshot !== null) {
      await ballots.acknowledgeClosed?.(vote.id).catch(() => null);
    }
    throw error;
  }
  return { status: "started", vote };
};

export const requestChatVoteClose = async (
  repository: ChatVotingRepository,
  channelId: string,
  scheduleClose: (pollId: string, deadline: number, ownerRevision: number) => Promise<void>,
  authorization?: ModuleMutationAuthorization,
): Promise<ChatVote | null> => {
  const vote = await repository.open(channelId);
  if (vote === null) return null;
  const requested = await repository.requestManualClose(channelId, vote.id, authorization);
  if (!requested) return null;
  await scheduleClose(vote.id, Date.now(), 1);
  return vote;
};

const messageText = (event: ModuleEvent): string | null => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const text = (message as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
};

const chatterId = (event: ModuleEvent): string | null =>
  typeof event.payload.chatter_user_id === "string" ? event.payload.chatter_user_id : null;

const directChat = (text: string) => ({ kind: "chat" as const, text, automated: false as const });

const canControlVotes = (event: ModuleEvent): boolean =>
  event.chatStatus?.includes("moderator") === true || event.chatStatus?.includes("broadcaster") === true;

const closeAlarmScheduler = (context: ModuleExecutionContext) => (
  pollId: string,
  deadline: number,
  ownerRevision: number,
): Promise<void> => context.scheduleAlarm(CHAT_VOTING_ALARM_HANDLER, pollId, deadline, ownerRevision);

export const processChatVotingMessage = async (
  event: ModuleEvent<ChatVotingSettings>,
  repository: ChatVotingRepository,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  const text = messageText(event);
  if (event.subscriptionType !== "channel.chat.message" || text === null || text.length === 0) {
    return { actions: [], diagnostics: [] };
  }
  const command = parseVoteCommand(text);
  const isChoice = /^[1-9]$/u.test(text.trim());
  if (command === null && !isChoice) return { actions: [], diagnostics: [] };

  const userId = chatterId(event);
  const botUserId = await context.botUserId?.() ?? null;
  if (userId === null || botUserId !== null && userId === botUserId) return { actions: [], diagnostics: [] };

  if (command !== null) {
    if (!canControlVotes(event)) return { actions: [], diagnostics: [] };
    const language = await context.channelLanguage();
    if (command.kind === "help") {
      return { actions: [directChat(chatVotingChatText(language, "help"))], diagnostics: [] };
    }
    if (command.kind === "end") {
      const closed = await requestChatVoteClose(repository, event.channelId, closeAlarmScheduler(context));
      return {
        actions: [directChat(chatVotingChatText(language, closed === null ? "noOpenVote" : "closing"))],
        diagnostics: [],
      };
    }

    try {
      const result = await startChatVote(repository, {
        channelId: event.channelId,
        preset: command.preset,
        optionCount: command.optionCount,
        settings: event.settings,
        language,
      }, context.ballots, closeAlarmScheduler(context));
      if (result.status === "busy") {
        return { actions: [directChat(chatVotingChatText(language, "busy"))], diagnostics: [] };
      }
      return {
        actions: [
          directChat(chatVotingChatText(language, "started", result.vote.optionCount)),
          { kind: "overlay", type: "opened", elementKind: CHAT_VOTING_ELEMENT_KIND, payload: { pollId: result.vote.id } },
        ],
        diagnostics: [],
      };
    } catch {
      return { actions: [directChat(chatVotingChatText(language, "startFailed"))], diagnostics: [] };
    }
  }

  const vote = await repository.open(event.channelId);
  if (vote === null) return { actions: [], diagnostics: [] };
  const closesAt = Date.parse(vote.closesAt);
  if (!Number.isFinite(closesAt) || Date.now() >= closesAt) return { actions: [], diagnostics: [] };
  const choice = ballotChoiceFromMessage(text, vote.optionCount);
  if (choice === null) return { actions: [], diagnostics: [] };
  const result = await context.ballots.cast(vote.id, userId, choice);
  if (result.status !== "counted" && result.status !== "changed") return { actions: [], diagnostics: [] };
  return {
    actions: [{
      kind: "overlay",
      type: "tally",
      elementKind: CHAT_VOTING_ELEMENT_KIND,
      payload: { pollId: vote.id, openedAt: vote.openedAt, counts: [...result.counts], revision: result.revision },
    }],
    diagnostics: [],
  };
};

interface StoredClosedSnapshot {
  counts: number[];
  revision: number;
}

const isStoredSnapshot = (value: unknown): value is StoredClosedSnapshot =>
  (() => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const counts: unknown = Reflect.get(value, "counts");
    const revision: unknown = Reflect.get(value, "revision");
    return Array.isArray(counts) && counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
      Number.isSafeInteger(revision) && (revision as number) >= 0;
  })();

const voteSnapshotStorageKey = (pollId: string): string => `closed:${pollId}`;

const alarmSettings = async (context: ModuleAlarmContext): Promise<ChatVotingSettings> => {
  const row = await context.DB.prepare(
    "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ? AND enabled = 1",
  ).bind(context.channelId, CHAT_VOTING_MODULE_ID).first<{ settings: string }>();
  if (row === null) return DEFAULT_CHAT_VOTING_SETTINGS;
  try {
    const parsed = chatVotingSettingsSchema.safeParse(JSON.parse(row.settings));
    return parsed.success ? parsed.data : DEFAULT_CHAT_VOTING_SETTINGS;
  } catch { return DEFAULT_CHAT_VOTING_SETTINGS; }
};

export const closeChatVoteFromAlarm = async (
  context: ModuleAlarmContext,
  repository: ChatVotingRepository,
  pollId: string,
): Promise<void> => {
  const vote = await repository.byId(context.channelId, pollId);
  if (vote === null) {
    await context.ballots.close(pollId);
    await context.ballots.acknowledgeClosed?.(pollId);
    await context.storage.delete(voteSnapshotStorageKey(pollId));
    return;
  }

  const storageKey = voteSnapshotStorageKey(pollId);
  const stored = await context.storage.get(storageKey);
  let snapshot: StoredClosedSnapshot | null = isStoredSnapshot(stored) ? stored : null;
  if (vote.status === "open") {
    if (snapshot === null) {
      const observed = await context.ballots.read(pollId);
      if (observed !== null) {
        snapshot = { counts: [...observed.counts], revision: observed.revision };
        // Keep a durable copy before handing ownership to close(), so a retry
        // can never turn a failed persistence step into a zero-count result.
        await context.storage.put(storageKey, snapshot);
      }
    }
    const closed = await context.ballots.close(pollId);
    if (closed !== null) snapshot = { counts: [...closed.counts], revision: closed.revision };
    snapshot ??= { counts: [...(vote.counts ?? Array.from({ length: vote.optionCount }, () => 0))], revision: 0 };
    await context.storage.put(storageKey, snapshot);
  }
  snapshot ??= {
    counts: [...(vote.counts ?? Array.from({ length: vote.optionCount }, () => 0))],
    revision: 0,
  };

  if (vote.status === "open") {
    await repository.finish(context.channelId, pollId, vote.closeReason, new Date().toISOString(), snapshot.counts);
  }
  const closedVote = await repository.byId(context.channelId, pollId);
  if (closedVote === null || closedVote.status !== "closed") throw new Error("The chat vote could not be closed.");

  await context.publishModuleOverlayMessage("tally", CHAT_VOTING_ELEMENT_KIND, {
    pollId,
    openedAt: closedVote.openedAt,
    status: "closed",
    counts: [...(closedVote.counts ?? snapshot.counts)],
    revision: snapshot.revision,
    closedAt: closedVote.closedAt ?? new Date().toISOString(),
    closeReason: closedVote.closeReason,
  });

  const settings = await alarmSettings(context);
  if (settings.announceResult) {
    const result = formatVoteResult(closedVote.labels, closedVote.counts ?? snapshot.counts);
    const rendered = await context.renderTemplate(
      settings.resultText,
      Date.parse(closedVote.closedAt ?? new Date().toISOString()),
      { "vote.result": result },
    );
    if (rendered.text.trim().length > 0) {
      const delivery = await context.sendChat(
        rendered.text,
        `chat-voting:${pollId}:result`,
        rendered.attributions,
        async () => (await repository.byId(context.channelId, pollId))?.status === "closed",
        settings.resultTarget,
      );
      if (delivery.retryable) throw new Error("The chat vote result is waiting for the automated output limit.");
    }
  }

  await context.ballots.acknowledgeClosed?.(pollId);
  await context.storage.delete(storageKey);
};

export const chatVotingAlarmDefinition = {
  key: CHAT_VOTING_ALARM_HANDLER,
  handle: async (context: ModuleAlarmContext, alarmKey: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(alarmKey)) throw new RangeError("The chat vote id is invalid.");
    await closeChatVoteFromAlarm(context, createChatVotingRepository(context.DB), alarmKey);
  },
};
