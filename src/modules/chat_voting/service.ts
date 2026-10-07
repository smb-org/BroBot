import type { BallotTermCount, ModuleEvent, ModuleExecutionContext, ModuleMutationAuthorization, ModuleResult } from "../contract";
import type { ModuleLanguage, ModuleAlarmContext } from "../contract";
import { CHAT_VOTING_ALARM_HANDLER, CHAT_VOTING_BALLOT_RETENTION_MS, CHAT_VOTING_ELEMENT_KIND, CHAT_VOTING_MODULE_ID, CHAT_VOTING_START_ANNOUNCEMENT_HANDLER, CHAT_VOTING_TITLE_MAX_LENGTH, DEFAULT_CHAT_VOTING_SETTINGS, DEFAULT_CHAT_VOTING_START_TEXT, DEFAULT_CHAT_VOTING_START_TEXT_EN, chatVotingSettingsSchema, chatVotingStartAnnouncementAlarmKey, chatVotingStartAnnouncementPollId } from "./contracts";
import type { ChatVote, ChatVoteDraft, ChatVotePreset, ChatVotingSettings, ChatVotingTextMode } from "./contracts";
import { configuredLabels, formatFreeTextVoteResult, formatVoteOptions, formatVoteResult, labelsForVote, normalizeBlockedVoteTerm, normalizeFreeTextVote, normalizeFreeTextVoteForMatching, normalizeVoteTitle, parseVoteCommand, voteChoiceFromMessage, voteCloseDeadline, voteLabelLength } from "./domain";
import type { ChatVotingRepository } from "./repository";
import { chatVotingChatText } from "./contracts/chat-defaults";
import { createChatVotingRepository } from "./repository";

export interface StartChatVoteInput {
  channelId: string;
  preset: ChatVotePreset;
  optionCount: number;
  labels?: readonly string[];
  title?: string | null;
  textMode?: ChatVotingTextMode;
  blockedTerms?: readonly string[] | null;
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
  scheduleStartAnnouncement?: (pollId: string, deadline: number, ownerRevision: number) => Promise<void>,
): Promise<VoteStartResult> => {
  const expectedOptionCount = input.preset === "free_text" ? 0
    : input.preset === "yes_no" || input.preset === "digit_01" || input.preset === "digit_12" ? 2
      : input.preset === "scale_5" ? 5 : null;
  if (input.preset === "options_n" && (!Number.isInteger(input.optionCount) || input.optionCount < 2 || input.optionCount > 9) ||
      expectedOptionCount !== null && input.optionCount !== expectedOptionCount) {
    throw new RangeError("The selected voting preset has an invalid option count.");
  }
  if (!Number.isInteger(input.optionCount) || input.optionCount < 0 || input.optionCount > 9 ||
      input.preset === "yes_no" && input.optionCount !== 2 ||
      input.preset === "scale_5" && input.optionCount !== 5) {
    throw new RangeError("The selected voting preset has an invalid option count.");
  }
  const voteLabels = input.labels === undefined
    ? labelsForVote(input.settings, input.preset, input.optionCount, input.language)
    : input.preset === "free_text" ? null : configuredLabels(input.labels, input.optionCount);
  if (voteLabels === null) throw new RangeError("The selected voting preset has invalid labels.");
  const title = normalizeVoteTitle(input.title ?? "");
  if (title !== null && voteLabelLength(title) > CHAT_VOTING_TITLE_MAX_LENGTH) throw new RangeError("The voting question is too long.");
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
    labels: voteLabels,
    title,
    textMode: input.preset === "free_text" ? input.textMode ?? "first_word" : null,
    termFilterReady: input.preset === "free_text" ? input.blockedTerms != null : null,
    openedAt: new Date(openedAt).toISOString(),
    closesAt: new Date(deadline.closesAt).toISOString(),
    requestedDurationSeconds: input.settings.autoCloseSeconds === 0 ? null : input.settings.autoCloseSeconds,
    closeReason: deadline.reason,
    status: "open",
    textResults: null,
    moreTerms: null,
  };
  const blockedTerms = input.blockedTerms === null || input.blockedTerms === undefined
    ? null
    : [...new Set(input.blockedTerms.map(normalizeBlockedVoteTerm).filter((term) => term.length > 0))];
  const opened = await ballots.open(
    vote.id,
    vote.optionCount,
    openedAt + CHAT_VOTING_BALLOT_RETENTION_MS,
    undefined,
    input.preset === "free_text" ? { blockedTerms } : undefined,
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
    if (input.settings.startText.trim().length > 0) {
      await scheduleStartAnnouncement?.(vote.id, openedAt, 0);
    }
  } catch (error: unknown) {
    const closedSnapshot = await ballots.close(vote.id).catch(() => null);
    if (inserted) {
      const textResults = vote.preset === "free_text" ? closedSnapshot?.terms ?? [] : null;
      const finished = await repository.finish(
        input.channelId,
        vote.id,
        vote.closeReason,
        new Date().toISOString(),
        Array.from({ length: vote.optionCount }, () => 0),
        textResults,
        closedSnapshot?.more ?? 0,
        vote.preset === "free_text"
          ? closedSnapshot?.termFilterReady ?? vote.termFilterReady ?? false
          : null,
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
  return { ...vote, closeReason: "manual" };
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

const startAnnouncementScheduler = (context: ModuleExecutionContext) => (
  pollId: string,
  deadline: number,
  ownerRevision: number,
): Promise<void> => context.scheduleAlarm(
  CHAT_VOTING_START_ANNOUNCEMENT_HANDLER,
  chatVotingStartAnnouncementAlarmKey(pollId),
  deadline,
  ownerRevision,
);

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

  const userId = chatterId(event);
  const botUserId = await context.botUserId?.() ?? null;
  if (userId === null || botUserId !== null && userId === botUserId) return { actions: [], diagnostics: [] };

  if (command === null && /^!vote(?:\s|$)/iu.test(text.trim())) {
    if (!canControlVotes(event)) return { actions: [], diagnostics: [] };
    return { actions: [directChat(chatVotingChatText(await context.channelLanguage(), "help"))], diagnostics: [] };
  }

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
      let blockedTerms: readonly string[] | null = null;
      if (command.preset === "free_text") {
        try { blockedTerms = await context.readChannelBlockedTerms?.() ?? null; }
        catch { blockedTerms = null; }
      }
      const result = await startChatVote(repository, {
        channelId: event.channelId,
        preset: command.preset,
        optionCount: command.optionCount,
        title: command.title,
        ...(command.textMode === undefined ? {} : { textMode: command.textMode }),
        ...(command.preset === "free_text" ? { blockedTerms } : {}),
        settings: event.settings,
        language,
      }, context.ballots, closeAlarmScheduler(context), startAnnouncementScheduler(context));
      if (result.status === "busy") {
        return { actions: [directChat(chatVotingChatText(language, "busy"))], diagnostics: [] };
      }
      return {
        actions: [
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
  if (vote.preset === "free_text") {
    const matchText = normalizeFreeTextVoteForMatching(text);
    const term = normalizeFreeTextVote(text, vote.textMode ?? "first_word");
    if (term === null || context.ballots.castTerm === undefined) return { actions: [], diagnostics: [] };
    const result = await context.ballots.castTerm(vote.id, userId, term, matchText);
    if (result.status !== "counted" && result.status !== "changed" && result.status !== "overflow") {
      return { actions: [], diagnostics: [] };
    }
    return {
      actions: [{
        kind: "overlay",
        type: "tally",
        elementKind: CHAT_VOTING_ELEMENT_KIND,
        payload: {
          pollId: vote.id,
          openedAt: vote.openedAt,
          preset: vote.preset,
          optionCount: vote.optionCount,
          title: vote.title,
          textMode: vote.textMode,
          labels: [...vote.labels],
          counts: [...result.counts],
          terms: (result.terms ?? []).map((entry) => ({ ...entry })),
          more: result.more ?? 0,
          termFilterReady: result.termFilterReady ?? false,
          revision: result.revision,
        },
      }],
      diagnostics: [],
    };
  }

  const choice = voteChoiceFromMessage(text, vote.preset, vote.optionCount);
  if (choice === null) return { actions: [], diagnostics: [] };
  const result = await context.ballots.cast(vote.id, userId, choice);
  if (result.status !== "counted" && result.status !== "changed") return { actions: [], diagnostics: [] };
  return {
    actions: [{
      kind: "overlay",
      type: "tally",
      elementKind: CHAT_VOTING_ELEMENT_KIND,
      payload: { pollId: vote.id, openedAt: vote.openedAt, title: vote.title, counts: [...result.counts], revision: result.revision },
    }],
    diagnostics: [],
  };
};

interface StoredClosedSnapshot {
  counts: number[];
  revision: number;
  terms?: BallotTermCount[];
  more?: number;
  termFilterReady?: boolean;
}

const isStoredSnapshot = (value: unknown): value is StoredClosedSnapshot =>
  (() => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const counts: unknown = Reflect.get(value, "counts");
    const revision: unknown = Reflect.get(value, "revision");
    const terms: unknown = Reflect.get(value, "terms");
    const more: unknown = Reflect.get(value, "more");
    const termFilterReady: unknown = Reflect.get(value, "termFilterReady");
    return Array.isArray(counts) && counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
      Number.isSafeInteger(revision) && (revision as number) >= 0 &&
      (terms === undefined || Array.isArray(terms) && terms.every((entry: unknown) => isStoredTerm(entry))) &&
      (more === undefined || Number.isSafeInteger(more) && (more as number) >= 0) &&
      (termFilterReady === undefined || typeof termFilterReady === "boolean");
  })();

const voteSnapshotStorageKey = (pollId: string): string => `closed:${pollId}`;

const isStoredTerm = (entry: unknown): boolean => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const term: unknown = Reflect.get(entry, "term");
  const count: unknown = Reflect.get(entry, "count");
  const approved: unknown = Reflect.get(entry, "approved");
  return typeof term === "string" && Array.from(term).length <= 25 &&
    Number.isSafeInteger(count) && (count as number) > 0 && typeof approved === "boolean";
};

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

const startAnnouncementTemplate = (startText: string, title: string | null, language: ModuleLanguage): string => {
  const usesDefault = startText === DEFAULT_CHAT_VOTING_START_TEXT || startText === DEFAULT_CHAT_VOTING_START_TEXT_EN;
  if (!usesDefault) return startText;
  const localized = language === "de" ? DEFAULT_CHAT_VOTING_START_TEXT : DEFAULT_CHAT_VOTING_START_TEXT_EN;
  return title === null ? localized.replace("{vote.title} – ", "") : localized;
};

export const announceChatVoteStartFromAlarm = async (
  context: ModuleAlarmContext,
  repository: ChatVotingRepository,
  pollId: string,
): Promise<void> => {
  const vote = await repository.byId(context.channelId, pollId);
  if (vote === null || vote.status !== "open") return;
  const settings = await alarmSettings(context);
  if (settings.startText.trim().length === 0) return;
  const language = await context.channelLanguage();
  const template = startAnnouncementTemplate(settings.startText, vote.title, language);
  const rendered = await context.renderTemplate(
    template,
    Date.parse(vote.openedAt),
    { "vote.title": vote.title ?? "", "vote.options": formatVoteOptions(vote, language) },
  );
  if (rendered.text.trim().length === 0) return;
  const delivery = await context.sendChat(
    rendered.text,
    `chat-voting:${pollId}:start`,
    rendered.attributions,
    async () => (await repository.byId(context.channelId, pollId))?.status === "open",
    "source_only",
  );
  if (delivery.retryable) throw new Error("The chat vote start announcement is waiting for the automated output limit.");
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
        snapshot = {
          counts: [...observed.counts],
          revision: observed.revision,
          ...(observed.terms === undefined ? {} : { terms: observed.terms.map((entry) => ({ ...entry })) }),
          ...(observed.more === undefined ? {} : { more: observed.more }),
          ...(observed.termFilterReady === undefined ? {} : { termFilterReady: observed.termFilterReady }),
        };
        // Keep a durable copy before handing ownership to close(), so a retry
        // can never turn a failed persistence step into a zero-count result.
        await context.storage.put(storageKey, snapshot);
      }
    }
    const closed = await context.ballots.close(pollId);
    if (closed !== null) snapshot = {
      counts: [...closed.counts],
      revision: closed.revision,
      ...(closed.terms === undefined ? {} : { terms: closed.terms.map((entry) => ({ ...entry })) }),
      ...(closed.more === undefined ? {} : { more: closed.more }),
      ...(closed.termFilterReady === undefined ? {} : { termFilterReady: closed.termFilterReady }),
    };
    snapshot ??= vote.preset === "free_text"
      ? { counts: [], revision: 0, terms: [], more: 0 }
      : { counts: [...(vote.counts ?? Array.from({ length: vote.optionCount }, () => 0))], revision: 0 };
    await context.storage.put(storageKey, snapshot);
  }
  snapshot ??= vote.preset === "free_text"
    ? { counts: [...(vote.counts ?? [])], revision: 0, terms: [...(vote.textResults ?? [])], more: vote.moreTerms ?? 0 }
    : { counts: [...(vote.counts ?? Array.from({ length: vote.optionCount }, () => 0))], revision: 0 };

  if (vote.status === "open") {
    await repository.finish(
      context.channelId,
      pollId,
      vote.closeReason,
      new Date().toISOString(),
      snapshot.counts,
      snapshot.terms ?? null,
      snapshot.more ?? 0,
      snapshot.termFilterReady ?? vote.termFilterReady ?? false,
    );
  }
  const closedVote = await repository.byId(context.channelId, pollId);
  if (closedVote === null || closedVote.status !== "closed") throw new Error("The chat vote could not be closed.");

  await context.publishModuleOverlayMessage("tally", CHAT_VOTING_ELEMENT_KIND, {
    pollId,
    openedAt: closedVote.openedAt,
    title: closedVote.title,
    status: "closed",
    counts: [...(closedVote.counts ?? snapshot.counts)],
    revision: snapshot.revision,
    ...(closedVote.textResults == null ? {} : { terms: closedVote.textResults.map((entry) => ({ ...entry })) }),
    ...(closedVote.moreTerms === null ? {} : { more: closedVote.moreTerms }),
    termFilterReady: closedVote.termFilterReady ?? snapshot.termFilterReady ?? false,
    closedAt: closedVote.closedAt ?? new Date().toISOString(),
    closeReason: closedVote.closeReason,
  });

  const settings = await alarmSettings(context);
  if (settings.announceResult) {
    const language = await context.channelLanguage();
    const result = closedVote.preset === "free_text"
      ? formatFreeTextVoteResult(
        closedVote.textResults ?? snapshot.terms ?? [],
        closedVote.moreTerms ?? snapshot.more ?? 0,
        language === "de" ? "weitere" : "more",
      )
      : formatVoteResult(closedVote.labels, closedVote.counts ?? snapshot.counts);
    const rendered = await context.renderTemplate(
      settings.resultText,
      Date.parse(closedVote.closedAt ?? new Date().toISOString()),
      {
        "vote.result": result,
        "vote.title": closedVote.title ?? "",
        "vote.options": formatVoteOptions(closedVote, language),
      },
    );
    const announcement = settings.resultText === DEFAULT_CHAT_VOTING_SETTINGS.resultText
      ? closedVote.title === null ? result
        : chatVotingChatText(language, "result", undefined, undefined, undefined, closedVote.title, result)
      : rendered.text;
    if (announcement.trim().length > 0) {
      const delivery = await context.sendChat(
        announcement,
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

export const chatVotingStartAnnouncementAlarmDefinition = {
  key: CHAT_VOTING_START_ANNOUNCEMENT_HANDLER,
  handle: async (context: ModuleAlarmContext, alarmKey: string) => {
    const pollId = chatVotingStartAnnouncementPollId(alarmKey);
    if (pollId === null) throw new RangeError("The chat vote id is invalid.");
    await announceChatVoteStartFromAlarm(context, createChatVotingRepository(context.DB), pollId);
  },
};
