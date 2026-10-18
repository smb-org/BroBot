import type { DryRunBlockCode, DryRunEffect, DryRunEntryReport } from "../../contracts/dry-run";
import type { BallotCastResult, ModuleAction, ModuleBallotAccess, ModuleDiagnostic, ModuleDryRunBallotSnapshot, ModuleDryRunContext, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { parseVoteCommand, voteChoiceFromMessage, normalizeFreeTextVote, isBlockedFreeTextVote } from "./domain";
import { createDryRunBallotAccess } from "../domain/dry-run-ballots";
import {
  createChatVotingRepository,
  peekChatVoteAlarmClose,
  peekChatVoteExtension,
  peekChatVoteExtensionRollback,
  peekChatVoteFinish,
  peekChatVoteManualClose,
  peekChatVoteOpenInsert,
  peekChatVoteResultDelivery,
} from "./repository";
import type { ChatVotingRepository } from "./repository";
import { canControlChatVoting, isChatVotingCommandLike, processChatVotingMessage } from "./service";
import type { ChatVote, ChatVoteTemplate, ChatVoteTerm, ChatVotingSettings } from "./contracts";

const messageText = (event: ModuleEvent): string => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return "";
  const text: unknown = Reflect.get(message, "text");
  return typeof text === "string" ? text : "";
};

const diagnosticValues = (diagnostic: ModuleDiagnostic): Readonly<Record<string, string | number | boolean | null>> => {
  const detail = diagnostic.detail;
  if (detail === undefined) return {};
  return Object.fromEntries(Object.entries(detail).filter(([, value]) =>
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")) as
    Readonly<Record<string, string | number | boolean | null>>;
};

type PinnedTemplateLookup =
  | { kind: "shortcut"; key: string; template: ChatVoteTemplate | null }
  | { kind: "legacy_alias"; key: NonNullable<ChatVoteTemplate["legacyAlias"]>; template: ChatVoteTemplate | null };

const simulatedRepository = (
  context: ModuleDryRunContext,
  channelId: string,
  source: ChatVotingRepository,
  openVote: ChatVote | null,
  templateLookup: PinnedTemplateLookup | null,
): ChatVotingRepository => {
  let latestRead: Promise<ChatVote | null> | null = null;
  let simulatedVote = openVote;
  const templates = {
    ...source.templates,
    ...(templateLookup?.kind === "shortcut" ? {
      templateByShortcut: (lookupChannelId: string, shortcut: string) =>
        lookupChannelId === channelId && shortcut === templateLookup.key
          ? Promise.resolve(templateLookup.template)
          : source.templates.templateByShortcut(lookupChannelId, shortcut),
    } : {}),
    ...(templateLookup?.kind === "legacy_alias" ? {
      templateByLegacyAlias: (lookupChannelId: string, alias: NonNullable<ChatVoteTemplate["legacyAlias"]>) =>
        lookupChannelId === channelId && alias === templateLookup.key
          ? Promise.resolve(templateLookup.template)
          : source.templates.templateByLegacyAlias(lookupChannelId, alias),
    } : {}),
    markTemplateUsed: () => Promise.resolve(),
  };
  return {
    ...source,
    open: (lookupChannelId) => lookupChannelId === channelId
      ? Promise.resolve(simulatedVote?.status === "closed" ? null : simulatedVote)
      : source.open(lookupChannelId),
    latest: async (lookupChannelId) => {
      if (lookupChannelId !== channelId) return await source.latest(lookupChannelId);
      if (simulatedVote !== null) return simulatedVote;
      latestRead ??= source.latest(lookupChannelId);
      return await latestRead;
    },
    byId: (lookupChannelId, pollId) =>
      lookupChannelId === channelId && simulatedVote?.id === pollId
        ? Promise.resolve(simulatedVote)
        : source.byId(lookupChannelId, pollId),
    insertOpen: async (vote, authorization, resultTextTemplate, blockGuard) => {
      const admission = await peekChatVoteOpenInsert(context.DB, vote, authorization, resultTextTemplate, blockGuard);
      if (admission !== "inserted") return admission;
      if (simulatedVote !== null && simulatedVote.status !== "closed") {
        throw new Error("An open D1 vote prevented the production insert.");
      }
      simulatedVote = { ...vote, status: "open", closedAt: null, counts: null, voterCount: null };
      return "inserted";
    },
    requestManualClose: async (lookupChannelId, pollId, expectedClosesAt, authorization) => {
      const requested = await peekChatVoteManualClose(context.DB, lookupChannelId, pollId, expectedClosesAt, authorization);
      if (requested && simulatedVote?.id === pollId) {
        simulatedVote = {
          ...simulatedVote,
          status: "closing",
          closeReason: "manual",
          closingAt: simulatedVote.closingAt ?? new Date().toISOString(),
          deadlineRevision: (simulatedVote.deadlineRevision ?? 0) + Number(simulatedVote.closingAt == null),
        };
      }
      return requested;
    },
    claimAlarmClose: async (lookupChannelId, pollId, expectedClosesAt, claimedAt) => {
      const claimed = await peekChatVoteAlarmClose(context.DB, lookupChannelId, pollId, expectedClosesAt, claimedAt);
      if (claimed && simulatedVote?.id === pollId) {
        simulatedVote = {
          ...simulatedVote,
          status: "closing",
          closingAt: claimedAt,
          deadlineRevision: (simulatedVote.deadlineRevision ?? 0) + Number(simulatedVote.closingAt == null),
        };
      }
      return claimed;
    },
    extendClose: async (lookupChannelId, pollId, expectedClosesAt, closesAt, authorization) => {
      const extended = await peekChatVoteExtension(context.DB, lookupChannelId, pollId, expectedClosesAt, authorization);
      if (extended && simulatedVote?.id === pollId) {
        simulatedVote = { ...simulatedVote, closesAt, deadlineRevision: (simulatedVote.deadlineRevision ?? 0) + 1 };
      }
      return extended;
    },
    rollbackCloseExtension: async (lookupChannelId, pollId, expectedClosesAt, expectedDeadlineRevision, closesAt) => {
      const rolledBack = await peekChatVoteExtensionRollback(
        context.DB, lookupChannelId, pollId, expectedClosesAt, expectedDeadlineRevision,
      );
      if (rolledBack && simulatedVote?.id === pollId) {
        simulatedVote = { ...simulatedVote, closesAt, deadlineRevision: (simulatedVote.deadlineRevision ?? 0) + 1 };
      }
      return rolledBack;
    },
    finish: async (lookupChannelId, pollId, closeReason, closedAt, counts, textResults, moreTerms, termFilterReady, resultDeliveryPending) => {
      const finished = await peekChatVoteFinish(context.DB, lookupChannelId, pollId);
      if (finished && simulatedVote?.id === pollId) {
        simulatedVote = {
          ...simulatedVote,
          status: "closed",
          closedAt,
          closeReason,
          counts: [...counts],
          voterCount: textResults == null
            ? counts.reduce((total, count) => total + count, 0)
            : textResults.reduce((total, entry) => total + entry.count, 0),
          textResults: textResults == null ? null : textResults.map((entry) => ({ ...entry })),
          moreTerms: textResults == null ? null : moreTerms ?? 0,
          termFilterReady: textResults == null || termFilterReady == null ? null : termFilterReady,
          resultDeliveryPending: resultDeliveryPending ?? false,
        };
      }
      return finished;
    },
    completeResultDelivery: async (lookupChannelId, pollId) => {
      const completed = await peekChatVoteResultDelivery(context.DB, lookupChannelId, pollId);
      if (completed && simulatedVote?.id === pollId) simulatedVote = { ...simulatedVote, resultDeliveryPending: false };
      return completed;
    },
    templates,
  };
};

const serviceContext = (context: ModuleDryRunContext, ballots: ModuleBallotAccess): ModuleExecutionContext => ({
  ...context,
  authorizeMutation: () => { throw new Error("Dry-run cannot authorize channel mutations."); },
  ballots,
  scheduleAlarm: () => Promise.resolve(),
  clearAlarm: () => Promise.resolve(),
} as unknown as ModuleExecutionContext);

const isChatVoteTerm = (value: unknown): value is ChatVoteTerm => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const term: unknown = Reflect.get(value, "term");
  const count: unknown = Reflect.get(value, "count");
  const approved: unknown = Reflect.get(value, "approved");
  return typeof term === "string" && Number.isSafeInteger(count) && (count as number) > 0 && typeof approved === "boolean";
};

const chatEffect = (action: Extract<ModuleAction, { kind: "chat" }>, context: ModuleDryRunContext): DryRunEffect => ({
  kind: "chat",
  text: action.text,
  target: action.target ?? context.defaultChatTarget,
  postsTo: "this_chat",
  reply: action.replyToMessageId !== undefined,
  suppressedBy: null,
  automated: action.automated ?? false,
});

export const dryRunChatVotingMessage = async (
  event: ModuleEvent<ChatVotingSettings>,
  context: ModuleDryRunContext,
): Promise<readonly DryRunEntryReport[]> => {
  const text = messageText(event);
  if (text.length === 0) return [];
  const command = parseVoteCommand(text);
  const commandLike = isChatVotingCommandLike(text, command);
  const source = createChatVotingRepository(context.DB);
  const openVote = await source.open(event.channelId);
  let templateLookup: PinnedTemplateLookup | null = null;
  if (command?.kind === "template") {
    templateLookup = {
      kind: "shortcut",
      key: command.shortcut,
      template: await source.templates.templateByShortcut(event.channelId, command.shortcut),
    };
  } else if (command?.kind === "legacyAlias") {
    templateLookup = {
      kind: "legacy_alias",
      key: command.alias,
      template: await source.templates.templateByLegacyAlias(event.channelId, command.alias),
    };
  }
  const repository = simulatedRepository(context, event.channelId, source, openVote, templateLookup);
  const voter = Reflect.get(event.payload, "chatter_user_id");
  const voterId = typeof voter === "string" && voter.length > 0 ? voter : undefined;
  const castResults = new Map<string, BallotCastResult>();
  const ballots = createDryRunBallotAccess(context, {
    isBlockedFreeTextVote,
    ...(voterId === undefined ? {} : { voterId }),
    onCastResult: (ballotId, result) => castResults.set(ballotId, result),
  });
  const initialSnapshot: ModuleDryRunBallotSnapshot | null = openVote === null
    ? null
    : await ballots.readSnapshot?.(openVote.id) ?? null;
  const ballotChoice = openVote === null || openVote.status !== "open" || openVote.kind === "free_text"
    ? null
    : voteChoiceFromMessage(text, openVote.kind, openVote.optionCount, openVote.labels);
  const textBallot = openVote?.status === "open" && openVote.kind === "free_text"
    ? normalizeFreeTextVote(text, openVote.textMode ?? "first_word")
    : null;
  const result: ModuleResult = await processChatVotingMessage(
    event,
    repository,
    serviceContext(context, ballots),
  );
  const ballotChoiceUnresolved = context.isBallotChoiceUnresolved?.() === true && initialSnapshot?.isActive !== false;
  if (result.actions.length === 0 && result.diagnostics.length === 0 && !ballotChoiceUnresolved) return [];
  const permissionBlocked = commandLike && !canControlChatVoting(event);
  const blocks: { code: DryRunBlockCode; detail?: Readonly<Record<string, string | number | boolean | null>> }[] = [];
  if (permissionBlocked) blocks.push({ code: "chat_voting.permission_denied" });
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.code !== "chat_voting.permission_denied") continue;
    const detail = diagnosticValues(diagnostic);
    if (!blocks.some(({ code }) => code === "chat_voting.permission_denied")) {
      blocks.push({ code: "chat_voting.permission_denied", ...(Object.keys(detail).length === 0 ? {} : { detail }) });
    }
  }
  const effects: DryRunEffect[] = [];
  for (const action of result.actions) {
    if (action.kind === "chat") {
      effects.push(chatEffect(action, context));
      continue;
    }
    if (action.kind === "overlay" && action.type === "opened") {
      effects.push({ kind: "ballot", moduleId: "chat_voting", action: "start", label: commandLike ? text.trim() : "Abstimmung" });
      continue;
    }
    if (action.kind === "overlay" && action.type === "tally") {
      const counts: unknown = Reflect.get(action.payload, "counts");
      const terms: unknown = Reflect.get(action.payload, "terms");
      const more: unknown = Reflect.get(action.payload, "more");
      const cast = openVote === null ? undefined : castResults.get(openVote.id);
      const overflow = cast?.status === "overflow";
      const savedTerms = Array.isArray(terms) && terms.every(isChatVoteTerm) ? terms : undefined;
      effects.push({
        kind: "ballot",
        moduleId: "chat_voting",
        action: overflow ? "overflow" : "count",
        label: openVote?.title ?? "Abstimmung",
        ...(overflow ? {} : { choice: textBallot ?? String(ballotChoice?.choice ?? text.trim()) }),
        ...(Array.isArray(counts) && counts.every((count) => typeof count === "number") ? { counts } : {}),
        ...(savedTerms === undefined ? {} : { terms: savedTerms }),
        ...(typeof more === "number" ? { more } : {}),
      });
    }
  }
  if (!commandLike && ballotChoice === null && textBallot === null && effects.length === 0) return [];

  const token = commandLike ? "!vote" : text.trim();
  return [{
    moduleId: "chat_voting",
    entry: { kind: "chat_vote", id: "chat-vote-message", label: commandLike ? text.trim() : `Stimme ${token}` },
    outcome: ballotChoiceUnresolved ? "indeterminate" : blocks.length === 0 ? "fires" : "blocked",
    match: { kind: "command_name", token },
    blocks,
    effects,
    templateNotes: [
      ...result.diagnostics.filter(({ code }) => code !== "chat_voting.permission_denied"),
      ...(ballotChoiceUnresolved
        ? [{ code: "template.deferred_live", detail: { name: "ballot.previous_choice" } }]
        : []),
    ],
  }];
};
