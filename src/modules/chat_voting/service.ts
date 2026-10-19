import type { BallotTermCount, ModuleEvent, ModuleExecutionContext, ModuleMutationAuthorization, ModuleResult } from "../contract";
import type { ModuleLanguage, ModuleAlarmContext } from "../contract";
import { CHAT_VOTING_ALARM_HANDLER, CHAT_VOTING_BALLOT_RETENTION_MS, CHAT_VOTING_ELEMENT_KIND, CHAT_VOTING_HARD_LIMIT_MS, CHAT_VOTING_MODULE_ID, CHAT_VOTING_START_ANNOUNCEMENT_HANDLER, CHAT_VOTING_TITLE_MAX_LENGTH, DEFAULT_CHAT_VOTING_SETTINGS, DEFAULT_CHAT_VOTING_START_TEXT, DEFAULT_CHAT_VOTING_START_TEXT_EN, chatVotingPresetForKind, chatVotingSettingsSchema, chatVotingStartAnnouncementAlarmKey, chatVotingStartAnnouncementPollId } from "./contracts";
import type { ChatVote, ChatVoteDraft, ChatVotePreset, ChatVoteTemplate, ChatVotingKind, ChatVotingSettings, ChatVotingTextMode } from "./contracts";
import { chatVoteTemplateConfiguration, configuredLabels, formatFreeTextVoteResult, formatVoteOptions, formatVoteResult, labelsForVote, normalizeBlockedVoteTerm, normalizeFreeTextVote, normalizeFreeTextVoteForMatching, normalizeVoteTitle, parseVoteCommand, templateStartProblem, voteChoiceFromMessage, voteCloseDeadline, voteLabelLength } from "./domain";
import type { ChatVoteResultTextTemplateSnapshot, ChatVotingRepository } from "./repository";
import type { VoteCommand } from "./domain";
import { chatVotingChatText, chatVotingDurationText, DEFAULT_CHAT_VOTING_START_DURATION_SUFFIX, LEGACY_CHAT_VOTING_START_TEXT, LEGACY_CHAT_VOTING_START_TEXT_EN } from "./contracts/chat-defaults";
import { createChatVotingRepository } from "./repository";
import { blockReferencesInText } from "../contracts/text-block-references";
import { readTextBlockGraphRevision, textBlockWriteGuard } from "../contracts/text-block-write-guard";
import type { TextBlockWriteGuard } from "../contracts/text-block-write-guard";
import { omitUnresolvedChatTemplateReferences } from "../../contracts/chat-template-references";

export interface StartChatVoteInput {
  channelId: string;
  kind: ChatVotingKind;
  optionCount: number;
  durationSeconds: number;
  labels?: readonly string[];
  title?: string | null;
  resultText?: string;
  resultTextTemplate?: ChatVoteResultTextTemplateSnapshot;
  resultTextWriteGuard?: TextBlockWriteGuard;
  textMode?: ChatVotingTextMode;
  blockedTerms?: readonly string[] | null;
  settings: ChatVotingSettings;
  language: ModuleLanguage;
  openedAt?: number;
  authorization?: ModuleMutationAuthorization;
}

export type VoteStartResult =
  | { status: "started"; vote: ChatVoteDraft }
  | { status: "reference_conflict" }
  | { status: "busy" };

const renderVoteChatTemplate = async (
  context: ModuleAlarmContext,
  template: string,
  now: number,
  values: Readonly<Record<string, string | number>>,
  triggerId: string,
): Promise<{ text: string; attributions?: readonly string[] }> => {
  const rendered = await context.renderTemplate(template, now, values);
  const safe = omitUnresolvedChatTemplateReferences(rendered.text);
  const diagnostics = [...(rendered.diagnostics ?? []), ...safe.diagnostics];
  if (diagnostics.length > 0) await context.writeDiagnostics?.(triggerId, diagnostics, new Date().toISOString());
  return { text: safe.text, ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }) };
};

const textBlockWriteGuardFor = async (
  db: D1Database,
  channelId: string,
  text: string,
): Promise<TextBlockWriteGuard | undefined> => {
  if (blockReferencesInText(text).length === 0) return undefined;
  return textBlockWriteGuard(channelId, await readTextBlockGraphRevision(db, channelId), [text]);
};

export const chatVotingTemplateValues = (
  vote: Pick<ChatVote, "title" | "kind" | "optionCount" | "labels" | "textMode" | "requestedDurationSeconds">,
  language: ModuleLanguage,
  result?: string,
): Record<string, string> => ({
  ...(result === undefined ? {} : { "vote.result": result }),
  "vote.title": vote.title ?? "",
  "vote.options": formatVoteOptions(vote, language),
  "vote.duration": chatVotingDurationText(language, vote.requestedDurationSeconds),
});

export const startChatVote = async (
  repository: ChatVotingRepository,
  input: StartChatVoteInput,
  ballots: ModuleExecutionContext["ballots"],
  scheduleClose: (pollId: string, deadline: number, ownerRevision: number) => Promise<void>,
  scheduleStartAnnouncement?: (pollId: string, deadline: number, ownerRevision: number) => Promise<void>,
): Promise<VoteStartResult> => {
  const kind = input.kind;
  const expectedOptionCount = kind === "free_text" ? 0 : kind === "yes_no" ? 2 : null;
  if (!Number.isInteger(input.optionCount) || input.optionCount < 0 || input.optionCount > 9 ||
      expectedOptionCount !== null && input.optionCount !== expectedOptionCount ||
      kind === "options" && (input.optionCount < 2 || input.optionCount > 9)) {
    throw new RangeError("The selected voting preset has an invalid option count.");
  }
  const voteLabels = input.labels === undefined
    ? labelsForVote(input.settings, chatVotingPresetForKind(kind), input.optionCount, input.language)
    : kind === "free_text" ? null : configuredLabels(input.labels, input.optionCount);
  if (voteLabels === null) throw new RangeError("The selected voting preset has invalid labels.");
  const title = normalizeVoteTitle(input.title ?? "");
  if (title !== null && voteLabelLength(title) > CHAT_VOTING_TITLE_MAX_LENGTH) throw new RangeError("The voting question is too long.");
  if (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 0 || input.durationSeconds > 14_400) {
    throw new RangeError("The voting duration is invalid.");
  }
  const requestedOpenedAt = input.openedAt ?? Date.now();
  const latestVote = await repository.latest(input.channelId);
  const latestOpenedAt = latestVote === null ? Number.NaN : Date.parse(latestVote.openedAt);
  const openedAt = Number.isFinite(latestOpenedAt)
    ? Math.max(requestedOpenedAt, latestOpenedAt + 1)
    : requestedOpenedAt;
  const deadline = voteCloseDeadline(openedAt, input.durationSeconds);
  const vote: ChatVoteDraft = {
    id: crypto.randomUUID(),
    channelId: input.channelId,
    kind,
    optionCount: input.optionCount,
    labels: voteLabels,
    title,
    resultText: input.resultText ?? input.settings.resultText,
    textMode: kind === "free_text" ? input.textMode ?? "first_word" : null,
    termFilterReady: kind === "free_text" ? input.blockedTerms != null : null,
    openedAt: new Date(openedAt).toISOString(),
    closesAt: new Date(deadline.closesAt).toISOString(),
    requestedDurationSeconds: input.durationSeconds === 0 ? null : input.durationSeconds,
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
    kind === "free_text" ? { blockedTerms } : undefined,
  );
  if (opened.status === "busy") return { status: "busy" };

  let inserted = false;
  try {
    const insertStatus = input.resultTextWriteGuard === undefined
      ? input.resultTextTemplate === undefined
        ? await repository.insertOpen(vote, input.authorization)
        : await repository.insertOpen(vote, input.authorization, input.resultTextTemplate)
      : await repository.insertOpen(vote, input.authorization, input.resultTextTemplate, input.resultTextWriteGuard);
    inserted = insertStatus === "inserted";
    if (insertStatus !== "inserted") {
      await ballots.close(vote.id);
      await ballots.acknowledgeClosed?.(vote.id);
      return insertStatus === "reference_conflict" ? { status: "reference_conflict" } : { status: "busy" };
    }
    await scheduleClose(vote.id, deadline.closesAt, 0);
    if (input.settings.startText.trim().length > 0) {
      await scheduleStartAnnouncement?.(vote.id, openedAt, 0);
    }
  } catch (error: unknown) {
    const closedSnapshot = await ballots.close(vote.id).catch(() => null);
    if (inserted) {
      const textResults = vote.kind === "free_text" ? closedSnapshot?.terms ?? [] : null;
      const finished = await repository.finish(
        input.channelId,
        vote.id,
        vote.closeReason,
        new Date().toISOString(),
        Array.from({ length: vote.optionCount }, () => 0),
        textResults,
        closedSnapshot?.more ?? 0,
        vote.kind === "free_text"
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
  options: { pollId?: string; onDeadlineRollback?: (vote: ChatVote) => Promise<void> } = {},
): Promise<ChatVote | null> => {
  const vote = options.pollId === undefined
    ? await repository.open(channelId)
    : await repository.byId(channelId, options.pollId);
  if (vote === null || vote.status === "closed") return null;
  const requested = await repository.requestManualClose(channelId, vote.id, vote.closesAt, authorization);
  if (!requested) return null;
  const deadline = Date.now();
  const closingVote = await repository.byId(channelId, vote.id) ?? {
    ...vote,
    status: "closing" as const,
    closeReason: "manual" as const,
    deadlineRevision: (vote.deadlineRevision ?? 0) + 1,
  };
  const ownerRevision = closingVote.deadlineRevision ?? Math.max(deadline, Date.parse(vote.closesAt)) + 1;
  await scheduleClose(vote.id, deadline, ownerRevision);
  return closingVote;
};

export const requestChatVoteExtension = async (
  repository: ChatVotingRepository,
  channelId: string,
  scheduleClose: (pollId: string, deadline: number, ownerRevision: number) => Promise<void>,
  authorization?: ModuleMutationAuthorization,
  options: { pollId?: string; onDeadlineRollback?: (vote: ChatVote) => Promise<void> } = {},
): Promise<ChatVote | null> => {
  const vote = await repository.open(channelId);
  if (vote === null || vote.status !== "open" || vote.closeReason === "manual" ||
      options.pollId !== undefined && vote.id !== options.pollId) return null;
  const openedAt = Date.parse(vote.openedAt);
  const closesAt = Date.parse(vote.closesAt);
  if (!Number.isFinite(openedAt) || !Number.isFinite(closesAt)) return null;
  const hardLimit = openedAt + CHAT_VOTING_HARD_LIMIT_MS;
  if (closesAt >= hardLimit) return null;
  const extendedUntil = Math.min(Math.max(closesAt, Date.now()) + 30_000, hardLimit);
  if (extendedUntil <= closesAt) return null;
  const nextClosesAt = new Date(extendedUntil).toISOString();
  if (!await repository.extendClose(channelId, vote.id, vote.closesAt, nextClosesAt, authorization)) return null;
  const extendedDeadlineRevision = (vote.deadlineRevision ?? 0) + 1;
  const extendedVote: ChatVote = { ...vote, closesAt: nextClosesAt, deadlineRevision: extendedDeadlineRevision };
  const scheduleWithRetry = async (deadline: number, ownerRevision: number): Promise<{ ok: true } | { ok: false; error: Error }> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await scheduleClose(vote.id, deadline, ownerRevision);
        return { ok: true };
      } catch (error: unknown) {
        const lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 1) return { ok: false, error: lastError };
      }
    }
    return { ok: false, error: new Error("The vote deadline alarm could not be scheduled.") };
  };
  const scheduleResult = await scheduleWithRetry(Date.parse(extendedVote.closesAt), extendedDeadlineRevision);
  if (!scheduleResult.ok) {
    let rolledBack: boolean;
    try {
      rolledBack = await repository.rollbackCloseExtension(
        channelId,
        vote.id,
        extendedVote.closesAt,
        extendedDeadlineRevision,
        vote.closesAt,
      );
    } catch (recoveryError: unknown) {
      throw new Error("The failed vote deadline reschedule could not be reconciled; the existing alarm will retry from persisted state.", { cause: recoveryError });
    }
    let currentVote: ChatVote | null;
    try {
      currentVote = await repository.byId(channelId, vote.id);
    } catch (recoveryError: unknown) {
      if (!rolledBack) {
        throw new Error("The failed vote deadline reschedule could not be reconciled; the existing alarm will retry from persisted state.", { cause: recoveryError });
      }
      const restoredRevision = extendedDeadlineRevision + 1;
      const restoredVote: ChatVote = { ...vote, deadlineRevision: restoredRevision };
      const recoveryResult = await scheduleWithRetry(Date.parse(restoredVote.closesAt), restoredRevision);
      if (!recoveryResult.ok) {
        throw recoveryResult.error;
      }
      await options.onDeadlineRollback?.(restoredVote);
      throw scheduleResult.error;
    }
    if (currentVote !== null && currentVote.status !== "closed") {
      const recoveryDeadline = currentVote.status === "closing" ? Date.now() : Date.parse(currentVote.closesAt);
      const recoveryRevision = currentVote.deadlineRevision ?? extendedDeadlineRevision + Number(rolledBack);
      const recoveryResult = await scheduleWithRetry(recoveryDeadline, recoveryRevision);
      if (!recoveryResult.ok) {
        throw recoveryResult.error;
      }
    }
    if (rolledBack) {
      if (currentVote !== null && currentVote.status !== "closed") await options.onDeadlineRollback?.(currentVote);
      throw scheduleResult.error;
    }
    if (currentVote?.status === "open" && currentVote.closesAt === extendedVote.closesAt) return currentVote;
    return currentVote;
  }
  try {
    return await repository.byId(channelId, vote.id) ?? extendedVote;
  } catch {
    return extendedVote;
  }
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

const invalidVoteMessages = {
  question: "invalidQuestion",
  questionTooLong: "invalidQuestionTooLong",
  answerCount: "invalidAnswerCount",
  labels: "invalidLabels",
  duration: "invalidDuration",
} as const;

export const canControlChatVoting = (event: ModuleEvent): boolean =>
  event.chatStatus?.includes("moderator") === true || event.chatStatus?.includes("broadcaster") === true;

export const isChatVotingCommandLike = (text: string, command = parseVoteCommand(text)): boolean =>
  command !== null || /^!vote(?:\s|$)/iu.test(text.trim());

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
  if (event.subscriptionType !== "channel.chat.message") return { actions: [], diagnostics: [] };
  const text = messageText(event);

  const openVote = await repository.open(event.channelId);
  if (text === null || text.length === 0) return { actions: [], diagnostics: [] };

  const command = parseVoteCommand(text);
  const commandLike = isChatVotingCommandLike(text, command);

  const userId = chatterId(event);
  const botUserId = await context.botUserId?.() ?? null;
  if (userId === null || botUserId !== null && userId === botUserId) return { actions: [], diagnostics: [] };

  if (command === null && commandLike) {
    if (!canControlChatVoting(event)) return { actions: [], diagnostics: [] };
    return { actions: [directChat(chatVotingChatText(await context.channelLanguage(), "help"))], diagnostics: [] };
  }

  if (command !== null) {
    if (!canControlChatVoting(event)) return { actions: [], diagnostics: [] };
    const language = await context.channelLanguage();
    if (command.kind === "help") {
      return { actions: [directChat(chatVotingChatText(language, "help"))], diagnostics: [] };
    }
    if (command.kind === "invalid") {
      return { actions: [directChat(chatVotingChatText(language, invalidVoteMessages[command.problem]))], diagnostics: [] };
    }
    if (command.kind === "end") {
      const closed = await requestChatVoteClose(repository, event.channelId, closeAlarmScheduler(context));
      return {
        actions: [directChat(chatVotingChatText(language, closed === null ? "noOpenVote" : "closing"))],
        diagnostics: [],
      };
    }

    let startCommand: Extract<VoteCommand, { kind: "start" }> | null = command.kind === "start" ? command : null;
    let templateToMarkUsed: ChatVoteTemplate | null = null;
    if (command.kind === "template") {
      const template = await repository.templates.templateByShortcut(event.channelId, command.shortcut);
      if (template === null) {
        return { actions: [directChat(chatVotingChatText(language, "unknownShortcut", undefined, undefined, undefined, command.shortcut))], diagnostics: [] };
      }
      const problem = templateStartProblem(template);
      if (problem !== null) {
        return { actions: [directChat(chatVotingChatText(language, "templateStartProblem", undefined, undefined, undefined, template.title, undefined, problem))], diagnostics: [] };
      }
      const configuration = chatVoteTemplateConfiguration(template);
      startCommand = { ...configuration, kind: "start", preset: chatVotingPresetForKind(configuration.voteKind) };
      templateToMarkUsed = template;
    }
    if (command.kind === "legacyAlias") {
      const template = await repository.templates.templateByLegacyAlias(event.channelId, command.alias);
      if (template !== null) {
        const problem = templateStartProblem(template);
        if (problem !== null) {
          return { actions: [directChat(chatVotingChatText(language, "templateStartProblem", undefined, undefined, undefined, template.title, undefined, problem))], diagnostics: [] };
        }
        const configuration = chatVoteTemplateConfiguration(template, command.title);
        startCommand = { ...configuration, kind: "start", preset: chatVotingPresetForKind(configuration.voteKind) };
        templateToMarkUsed = template;
      } else {
        const preset: ChatVotePreset = command.alias === "scale" ? "scale_5"
          : command.alias === "zeroOne" ? "digit_01" : command.alias === "oneTwo" ? "digit_12" : "yes_no";
        const voteKind: ChatVotingKind = preset === "yes_no" ? "yes_no" : "options";
        const optionCount = preset === "scale_5" ? 5 : 2;
        startCommand = {
          kind: "start",
          voteKind,
          preset,
          optionCount,
          labels: labelsForVote(event.settings, preset, optionCount, language),
          title: command.title,
        };
      }
    }
    if (command.kind === "again") {
      const previous = await repository.latest(event.channelId);
      if (previous === null || previous.status !== "closed") {
        const reply = previous?.status === "open" ? "busy" : "noPreviousVote";
        return { actions: [directChat(chatVotingChatText(language, reply))], diagnostics: [] };
      }
      startCommand = {
        kind: "start",
        voteKind: previous.kind,
        preset: chatVotingPresetForKind(previous.kind),
        optionCount: previous.optionCount,
        ...(previous.kind === "free_text" ? {} : { labels: previous.labels }),
        ...(previous.kind === "free_text" ? { textMode: previous.textMode ?? "first_word" } : {}),
        title: previous.title,
        ...(previous.resultText == null ? {} : { resultText: previous.resultText }),
        durationSeconds: previous.requestedDurationSeconds ?? event.settings.autoCloseSeconds,
      };
    }
    if (startCommand === null) return { actions: [], diagnostics: [] };

    try {
      let blockedTerms: readonly string[] | null = null;
      if (startCommand.voteKind === "free_text") {
        try { blockedTerms = await context.readChannelBlockedTerms?.() ?? null; }
        catch { blockedTerms = null; }
      }
      const resultTextWriteGuard = templateToMarkUsed === null && command.kind !== "again"
        ? await textBlockWriteGuardFor(context.DB, event.channelId, startCommand.resultText ?? event.settings.resultText)
        : undefined;
      const result = await startChatVote(repository, {
        channelId: event.channelId,
        kind: startCommand.voteKind,
        optionCount: startCommand.optionCount,
        durationSeconds: startCommand.durationSeconds ?? event.settings.autoCloseSeconds,
        ...(startCommand.labels === undefined ? {} : { labels: startCommand.labels }),
        title: startCommand.title,
        ...(startCommand.resultText === undefined ? {} : { resultText: startCommand.resultText }),
        ...(resultTextWriteGuard === undefined ? {} : { resultTextWriteGuard }),
        ...(templateToMarkUsed === null ? {} : {
          resultTextTemplate: {
            id: templateToMarkUsed.id,
            revision: templateToMarkUsed.revision,
            resultText: templateToMarkUsed.resultText ?? "{vote.result}",
          },
        }),
        ...(startCommand.textMode === undefined ? {} : { textMode: startCommand.textMode }),
        ...(startCommand.voteKind === "free_text" ? { blockedTerms } : {}),
        settings: event.settings,
        language,
      }, context.ballots, closeAlarmScheduler(context), startAnnouncementScheduler(context));
      if (result.status === "busy") {
        return { actions: [directChat(chatVotingChatText(language, "busy"))], diagnostics: [] };
      }
      if (result.status === "reference_conflict") {
        return { actions: [directChat(chatVotingChatText(language, "startFailed"))], diagnostics: [] };
      }
      if (templateToMarkUsed !== null) {
        try {
          await repository.templates.markTemplateUsed(event.channelId, templateToMarkUsed.id, result.vote.openedAt);
        } catch {
          // Usage ordering is secondary to the already opened vote.
        }
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

  const vote = openVote;
  if (vote === null || vote.status !== "open") return { actions: [], diagnostics: [] };
  const closesAt = Date.parse(vote.closesAt);
  if (!Number.isFinite(closesAt) || Date.now() >= closesAt) return { actions: [], diagnostics: [] };
  if (vote.kind === "free_text") {
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
          closesAt: vote.closesAt,
          requestedDurationSeconds: vote.requestedDurationSeconds,
          kind: vote.kind,
          preset: chatVotingPresetForKind(vote.kind),
          optionCount: vote.optionCount,
          title: vote.title,
          textMode: vote.textMode ?? null,
          labels: [...vote.labels],
          counts: [...result.counts],
          terms: (result.terms ?? []).map((entry) => ({ ...entry })),
          more: result.more ?? 0,
          termFilterReady: result.termFilterReady ?? false,
          revision: result.revision,
          deadlineRevision: vote.deadlineRevision ?? 0,
        },
      }],
      diagnostics: [],
    };
  }

  const choice = voteChoiceFromMessage(text, vote.kind, vote.optionCount, vote.labels);
  if (choice === null) return { actions: [], diagnostics: [] };
  const result = await context.ballots.cast(vote.id, userId, choice.choice,
    choice.source === "word" ? { onlyIfNew: true } : undefined);
  if (result.status !== "counted" && result.status !== "changed") return { actions: [], diagnostics: [] };
  return {
    actions: [{
      kind: "overlay",
      type: "tally",
      elementKind: CHAT_VOTING_ELEMENT_KIND,
      payload: {
        pollId: vote.id,
        openedAt: vote.openedAt,
        closesAt: vote.closesAt,
        requestedDurationSeconds: vote.requestedDurationSeconds,
        kind: vote.kind,
        preset: chatVotingPresetForKind(vote.kind),
        optionCount: vote.optionCount,
        labels: [...vote.labels],
        textMode: vote.textMode ?? null,
        title: vote.title,
        counts: [...result.counts],
        revision: result.revision,
        deadlineRevision: vote.deadlineRevision ?? 0,
      },
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

export const startAnnouncementTemplate = (
  startText: string,
  title: string | null,
  duration: string,
  language: ModuleLanguage,
): string => {
  const usesDefault = startText === DEFAULT_CHAT_VOTING_START_TEXT ||
    startText === DEFAULT_CHAT_VOTING_START_TEXT_EN ||
    startText === LEGACY_CHAT_VOTING_START_TEXT ||
    startText === LEGACY_CHAT_VOTING_START_TEXT_EN;
  if (!usesDefault) return startText;
  const localized = language === "de" ? DEFAULT_CHAT_VOTING_START_TEXT : DEFAULT_CHAT_VOTING_START_TEXT_EN;
  let result = localized;
  if (title === null) result = result.replace("{vote.title} – ", "");
  if (duration.length === 0) {
    result = result.replace(DEFAULT_CHAT_VOTING_START_DURATION_SUFFIX[language], "");
  }
  return result;
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
  const values = chatVotingTemplateValues(vote, language);
  const template = startAnnouncementTemplate(settings.startText, vote.title, values["vote.duration"] ?? "", language);
  const rendered = await renderVoteChatTemplate(
    context,
    template,
    Date.parse(vote.openedAt),
    values,
    `chat-voting:${pollId}:start`,
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
  let vote = await repository.byId(context.channelId, pollId);
  if (vote === null) {
    await context.ballots.close(pollId);
    await context.ballots.acknowledgeClosed?.(pollId);
    await context.storage.delete(voteSnapshotStorageKey(pollId));
    return;
  }

  if (vote.status === "open") {
    const now = Date.now();
    const closesAt = Date.parse(vote.closesAt);
    if (vote.closeReason !== "manual") {
      if (!Number.isFinite(closesAt)) throw new Error("The persisted vote deadline is invalid.");
      if (now < closesAt) {
        await context.schedule(pollId, closesAt, vote.deadlineRevision ?? 0);
        return;
      }
    }
    const claimed = await repository.claimAlarmClose(
      context.channelId,
      pollId,
      vote.closesAt,
      new Date(now).toISOString(),
    );
    if (!claimed) {
      const currentVote = await repository.byId(context.channelId, pollId);
      if (currentVote === null || currentVote.status === "closed") return;
      if (currentVote.status === "closing") {
        // The manual close or another alarm owns the claim. This handler still
        // owns the running alarm, so finish the persisted close instead of
        // acknowledging it while the vote is left without a recovery alarm.
        vote = currentVote;
      } else {
        const currentDeadline = currentVote.closeReason === "manual"
          ? Date.now()
          : Date.parse(currentVote.closesAt);
        if (!Number.isFinite(currentDeadline)) throw new Error("The persisted vote deadline is invalid.");
        // A lost claim can also mean that the deadline changed while this
        // alarm was running. Confirm a new alarm for the persisted state
        // before allowing the current alarm to complete.
        await context.schedule(pollId, currentDeadline, currentVote.deadlineRevision ?? 0);
        return;
      }
    } else {
      vote = await repository.byId(context.channelId, pollId);
      if (vote === null || vote.status === "closed") return;
    }
  }

  const storageKey = voteSnapshotStorageKey(pollId);
  const stored = await context.storage.get(storageKey);
  let snapshot: StoredClosedSnapshot | null = isStoredSnapshot(stored) ? stored : null;
  if (vote.status !== "closed") {
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
    snapshot ??= vote.kind === "free_text"
      ? { counts: [], revision: 0, terms: [], more: 0 }
      : { counts: [...(vote.counts ?? Array.from({ length: vote.optionCount }, () => 0))], revision: 0 };
    await context.storage.put(storageKey, snapshot);
  }
  snapshot ??= vote.kind === "free_text"
    ? { counts: [...(vote.counts ?? [])], revision: 0, terms: [...(vote.textResults ?? [])], more: vote.moreTerms ?? 0 }
    : { counts: [...(vote.counts ?? Array.from({ length: vote.optionCount }, () => 0))], revision: 0 };

  const settings = await alarmSettings(context);
  const resultTextTemplate = vote.resultText ?? settings.resultText;
  const resultDeliveryPending = settings.announceResult && resultTextTemplate.trim().length > 0;

  if (vote.status !== "closed") {
    await repository.finish(
      context.channelId,
      pollId,
      vote.closeReason,
      new Date().toISOString(),
      snapshot.counts,
      snapshot.terms ?? null,
      snapshot.more ?? 0,
      snapshot.termFilterReady ?? vote.termFilterReady ?? false,
      resultDeliveryPending,
    );
  }
  const closedVote = await repository.byId(context.channelId, pollId);
  if (closedVote === null || closedVote.status !== "closed") throw new Error("The chat vote could not be closed.");

  await context.publishModuleOverlayMessage("tally", CHAT_VOTING_ELEMENT_KIND, {
    pollId,
    openedAt: closedVote.openedAt,
    closesAt: closedVote.closesAt,
    requestedDurationSeconds: closedVote.requestedDurationSeconds,
    kind: closedVote.kind,
    preset: chatVotingPresetForKind(closedVote.kind),
    optionCount: closedVote.optionCount,
    labels: [...closedVote.labels],
    textMode: closedVote.textMode ?? null,
    title: closedVote.title,
    status: "closed",
    counts: [...(closedVote.counts ?? snapshot.counts)],
    revision: snapshot.revision,
    ...(closedVote.textResults == null ? {} : { terms: closedVote.textResults.map((entry) => ({ ...entry })) }),
    ...(closedVote.moreTerms === null ? {} : { more: closedVote.moreTerms }),
    termFilterReady: closedVote.termFilterReady ?? snapshot.termFilterReady ?? false,
    closedAt: closedVote.closedAt ?? new Date().toISOString(),
    closeReason: closedVote.closeReason,
    deadlineRevision: closedVote.deadlineRevision ?? 0,
  });

  if (settings.announceResult && closedVote.resultDeliveryPending) {
    const language = await context.channelLanguage();
    const deliveryVote = await repository.byId(context.channelId, pollId);
    if (deliveryVote === null || deliveryVote.status !== "closed" || !deliveryVote.resultDeliveryPending) {
      throw new Error("The chat vote result changed before it could be sent.");
    }
    const result = deliveryVote.kind === "free_text"
      ? formatFreeTextVoteResult(
        deliveryVote.textResults ?? snapshot.terms ?? [],
        deliveryVote.moreTerms ?? snapshot.more ?? 0,
        language === "de" ? "weitere" : "more",
      )
      : formatVoteResult(deliveryVote.labels, deliveryVote.counts ?? snapshot.counts);
    const resultText = deliveryVote.resultText ?? settings.resultText;
    const isDefaultResultText = resultText === DEFAULT_CHAT_VOTING_SETTINGS.resultText;
    const rendered = isDefaultResultText ? null : await renderVoteChatTemplate(
      context,
      resultText,
      Date.parse(deliveryVote.closedAt ?? new Date().toISOString()),
      chatVotingTemplateValues(deliveryVote, language, result),
      `chat-voting:${pollId}:result`,
    );
    const announcement = isDefaultResultText
      ? deliveryVote.title === null ? result
        : chatVotingChatText(language, "result", undefined, undefined, undefined, deliveryVote.title, result)
      : rendered?.text ?? "";
    const safeAnnouncement = omitUnresolvedChatTemplateReferences(announcement);
    if (safeAnnouncement.diagnostics.length > 0) {
      await context.writeDiagnostics?.(
        `chat-voting:${pollId}:result`,
        safeAnnouncement.diagnostics,
        new Date().toISOString(),
      );
    }
    if (safeAnnouncement.text.trim().length > 0) {
      const delivery = await context.sendChat(
        safeAnnouncement.text,
        `chat-voting:${pollId}:result`,
        rendered?.attributions,
        async () => {
          const current = await repository.byId(context.channelId, pollId);
          return current !== null && current.status === "closed" && current.resultDeliveryPending === true;
        },
        settings.resultTarget,
      );
      if (delivery.reason === "stale_before_send") {
        throw new Error("The chat vote result changed before it could be sent.");
      }
      if (delivery.retryable) throw new Error("The chat vote result is waiting for the automated output limit.");
    }
  }

  await repository.completeResultDelivery(context.channelId, pollId);
  await context.ballots.acknowledgeClosed?.(pollId);
  await context.storage.delete(storageKey);
};

export const chatVotingAlarmDefinition = {
  key: CHAT_VOTING_ALARM_HANDLER,
  retryDelaysMs: [5_000, 15_000, 60_000],
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
