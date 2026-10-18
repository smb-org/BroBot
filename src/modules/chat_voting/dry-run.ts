import type { DryRunBlockCode, DryRunEffect, DryRunEntryReport } from "../../contracts/dry-run";
import type { ModuleAction, ModuleDiagnostic, ModuleDryRunContext, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { parseVoteCommand, voteChoiceFromMessage, normalizeFreeTextVote, isBlockedFreeTextVote } from "./domain";
import { createDryRunBallotAccess } from "../domain/dry-run-ballots";
import { createChatVotingRepository } from "./repository";
import type { ChatVotingRepository } from "./repository";
import { processChatVotingMessage } from "./service";
import type { ChatVotingSettings } from "./contracts";

const messageText = (event: ModuleEvent): string => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return "";
  const text: unknown = Reflect.get(message, "text");
  return typeof text === "string" ? text : "";
};

const commandControlAllowed = (event: ModuleEvent): boolean =>
  event.chatStatus?.includes("moderator") === true || event.chatStatus?.includes("broadcaster") === true;

const diagnosticValues = (diagnostic: ModuleDiagnostic): Readonly<Record<string, string | number | boolean | null>> => {
  const detail = diagnostic.detail;
  if (detail === undefined) return {};
  return Object.fromEntries(Object.entries(detail).filter(([, value]) =>
    value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")) as
    Readonly<Record<string, string | number | boolean | null>>;
};

const simulatedRepository = (
  context: ModuleDryRunContext,
): ChatVotingRepository => {
  const repository = createChatVotingRepository(context.DB);
  return {
    ...repository,
    insertOpen: async (_vote, _authorization, _resultTextTemplate, blockGuard) => {
      if (blockGuard !== undefined && blockGuard.references.length > 0) {
        const valid = await context.DB.prepare(`SELECT 1 AS valid WHERE 1 = 1 ${blockGuard.sql}`)
          .bind(...blockGuard.values).first<{ valid: number }>();
        if (valid === null) return "reference_conflict";
      }
      return await context.ballots?.hasOpenBallotSnapshot() ? "busy" : "inserted";
    },
    requestManualClose: async (channelId, pollId, expectedClosesAt) => {
      const vote = await repository.byId(channelId, pollId);
      return vote?.status === "open" && vote.closesAt === expectedClosesAt;
    },
    claimAlarmClose: () => Promise.resolve(false),
    extendClose: () => Promise.resolve(false),
    rollbackCloseExtension: () => Promise.resolve(false),
    finish: () => Promise.resolve(false),
    completeResultDelivery: () => Promise.resolve(false),
    templates: {
      ...repository.templates,
      markTemplateUsed: () => Promise.resolve(),
    },
  };
};

const serviceContext = (context: ModuleDryRunContext): ModuleExecutionContext => ({
  ...context,
  authorizeMutation: () => Promise.resolve({ sql: "", values: [] }),
  ballots: createDryRunBallotAccess(context, { isBlockedFreeTextVote }),
  scheduleAlarm: () => Promise.resolve(),
  clearAlarm: () => Promise.resolve(),
} as unknown as ModuleExecutionContext);

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
  const commandLike = command !== null || /^!vote(?:\s|$)/iu.test(text.trim());
  const repository = simulatedRepository(context);
  const openVote = await repository.open(event.channelId);
  const ballotChoice = openVote === null || openVote.status !== "open" || openVote.kind === "free_text"
    ? null
    : voteChoiceFromMessage(text, openVote.kind, openVote.optionCount, openVote.labels);
  const textBallot = openVote?.status === "open" && openVote.kind === "free_text"
    ? normalizeFreeTextVote(text, openVote.textMode ?? "first_word")
    : null;
  const result: ModuleResult = await processChatVotingMessage(event, repository, serviceContext(context));
  const permissionBlocked = commandLike && !commandControlAllowed(event);
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
      effects.push({
        kind: "ballot",
        moduleId: "chat_voting",
        action: "count",
        label: openVote?.title ?? "Abstimmung",
        choice: textBallot ?? String(ballotChoice?.choice ?? text.trim()),
        ...(Array.isArray(counts) && counts.every((count) => typeof count === "number") ? { counts } : {}),
      });
    }
  }
  if (effects.length === 0 && blocks.length === 0 && (ballotChoice !== null || textBallot !== null)) {
    blocks.push({ code: "chat_voting.vote_unavailable" });
  }
  if (!commandLike && ballotChoice === null && textBallot === null && effects.length === 0) return [];

  const token = commandLike ? "!vote" : text.trim();
  return [{
    moduleId: "chat_voting",
    entry: { kind: "chat_vote", id: "chat-vote-message", label: commandLike ? text.trim() : `Stimme ${token}` },
    outcome: blocks.length === 0 ? "fires" : "blocked",
    match: { kind: "command_name", token },
    blocks,
    effects,
    templateNotes: result.diagnostics.filter(({ code }) => code !== "chat_voting.permission_denied"),
  }];
};
