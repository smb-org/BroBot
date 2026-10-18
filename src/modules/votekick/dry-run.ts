import type { DryRunBlockCode, DryRunEffect, DryRunEntryReport } from "../../contracts/dry-run";
import type { ModuleAction, ModuleDiagnostic, ModuleDryRunContext, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { ballotChoiceFromMessage } from "../contract";
import { createDryRunBallotAccess } from "../domain/dry-run-ballots";
import { createVotekickRepository, peekVotekickAdmission } from "./adapters/d1";
import type { VotekickRepository } from "./repository";
import { VOTEKICK_COMMAND_PATTERN } from "./domain";
import type { VotekickSettings } from "./contracts";
import { votekickFinalizeRule, processVotekickMessage } from "./service";

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

const blockCodeForReason = (reason: unknown): DryRunBlockCode => {
  if (reason === "starter_not_authorized") return "votekick.permission_denied";
  if (reason === "target_protected") return "votekick.target_protected";
  if (reason === "target_not_active") return "votekick.target_inactive";
  if (reason === "channel_cooldown" || reason === "target_cooldown") return "votekick.cooldown";
  if (reason === "busy") return "votekick.ballot_busy";
  return "votekick.unavailable";
};

const simulatedRepository = (context: ModuleDryRunContext): VotekickRepository => {
  const repository = createVotekickRepository(context.DB);
  const finalized = new Map<string, { status: "passed" | "expired"; yesVotes: number; noVotes: number; ballotRevision: number; durationSeconds: number | null; endedAt: string }>();
  return {
    ...repository,
    admit: async (channelId, input, checkedAt, channelCooldownSeconds, targetCooldownSeconds) => await peekVotekickAdmission(
      context.DB,
      channelId,
      input.targetUserId,
      checkedAt,
      channelCooldownSeconds,
      targetCooldownSeconds,
    ),
    byId: async (channelId, id) => {
      const current = await repository.byId(channelId, id);
      const final = finalized.get(id);
      return current === null || final === undefined ? current : { ...current, ...final };
    },
    updateCounts: () => Promise.resolve(),
    finalize: (_channelId, id, status, yesVotes, noVotes, ballotRevision, durationSeconds, endedAt) => {
      finalized.set(id, { status, yesVotes, noVotes, ballotRevision, durationSeconds, endedAt });
      return Promise.resolve(true);
    },
    finish: () => Promise.resolve(true),
    cancel: () => Promise.resolve(null),
    markLifted: () => Promise.resolve(false),
  };
};

const serviceContext = (
  context: ModuleDryRunContext,
  rules: ReadonlyMap<string, ReturnType<typeof votekickFinalizeRule>> = new Map(),
): ModuleExecutionContext => ({
  ...context,
  authorizeMutation: () => Promise.resolve({ sql: "", values: [] }),
  ballots: createDryRunBallotAccess(context, { initialRules: rules }),
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

const actionEffects = (
  actions: readonly ModuleAction[],
  event: ModuleEvent,
  context: ModuleDryRunContext,
  initialOutcome: "passed" | "expired" | "not_open" | undefined,
): DryRunEffect[] => {
  const text = messageText(event);
  const command = VOTEKICK_COMMAND_PATTERN.exec(text.trim());
  const choice = ballotChoiceFromMessage(text, 2);
  const timeout = actions.find((action): action is Extract<ModuleAction, { kind: "timeout" }> => action.kind === "timeout");
  const overlay = actions.find((action): action is Extract<ModuleAction, { kind: "overlay" }> => action.kind === "overlay");
  const effects: DryRunEffect[] = [];
  if (overlay?.type === "opened") {
    const target = Reflect.get(overlay.payload, "targetLogin");
    effects.push({
      kind: "ballot",
      moduleId: "votekick",
      action: "start",
      label: typeof target === "string" ? target : command?.[1] ?? "Votekick",
      counts: [1, 0],
    });
  } else if (overlay?.type === "tally") {
    const target = Reflect.get(overlay.payload, "targetLogin");
    const yes = Reflect.get(overlay.payload, "yesVotes");
    const no = Reflect.get(overlay.payload, "noVotes");
    const counts = typeof yes === "number" && typeof no === "number" ? [yes, no] : undefined;
    if (choice !== null && initialOutcome === undefined) {
      effects.push({
        kind: "ballot",
        moduleId: "votekick",
        action: "count",
        label: typeof target === "string" ? target : "Votekick",
        choice: choice === 1 ? "yes" : "no",
        ...(counts === undefined ? {} : { counts }),
      });
    }
    if (timeout !== undefined || initialOutcome !== undefined || choice === null) {
      effects.push({
        kind: "ballot",
        moduleId: "votekick",
        action: "finalize",
        label: typeof target === "string" ? target : "Votekick",
        ...(counts === undefined ? {} : { counts }),
      });
    }
  }
  for (const action of actions) {
    if (action.kind === "chat") effects.push(chatEffect(action, context));
    if (action.kind === "timeout") {
      effects.push({ kind: "timeout", minSeconds: action.durationSeconds, maxSeconds: action.durationSeconds, reason: action.reason });
      for (const followUp of [action.onSuccess, action.onFailure]) {
        if (followUp?.kind === "chat") effects.push(chatEffect(followUp, context));
      }
    }
  }
  return effects;
};

export const dryRunVotekickMessage = async (
  event: ModuleEvent<VotekickSettings>,
  context: ModuleDryRunContext,
): Promise<readonly DryRunEntryReport[]> => {
  const text = messageText(event);
  if (text.length === 0) return [];
  const command = VOTEKICK_COMMAND_PATTERN.exec(text.trim());
  const choice = ballotChoiceFromMessage(text, 2);
  const repository = simulatedRepository(context);
  const current = await repository.running(event.channelId);
  const initialSnapshot = current === null ? null : await context.ballots?.readSnapshot(current.id) ?? null;
  const rules = current === null ? new Map() : new Map([[current.id, votekickFinalizeRule(current.threshold)]]);
  const result: ModuleResult = await processVotekickMessage(event, repository, serviceContext(context, rules));
  const rejected = result.diagnostics.find(({ code }) => code === "votekick.rejected");
  const rejectedDetail = rejected === undefined ? {} : diagnosticValues(rejected);
  const blocks = rejected === undefined ? [] : [{ code: blockCodeForReason(rejectedDetail.reason), detail: rejectedDetail }];
  const effects = actionEffects(result.actions, event, context, initialSnapshot?.outcome);
  if (command === null && choice === null && effects.length === 0 && blocks.length === 0) return [];
  const token = command === null ? choice === null ? "any chat message" : text.trim() : "!votekick";
  return [{
    moduleId: "votekick",
    entry: { kind: "votekick", id: "votekick-message", label: command === null ? token : text.trim() },
    outcome: blocks.length === 0 ? "fires" : "blocked",
    match: command === null && choice === null
      ? { kind: "keyword", pattern: "any chat message" }
      : { kind: "command_name", token },
    blocks,
    effects,
    templateNotes: result.diagnostics.filter(({ code }) => code !== "votekick.rejected"),
  }];
};
