import type { DryRunBlockCode, DryRunEffect, DryRunEntryReport } from "../../contracts/dry-run";
import type { BallotCastResult, ModuleAction, ModuleBallotAccess, ModuleDiagnostic, ModuleDryRunContext, ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { ballotChoiceFromMessage } from "../contract";
import { createDryRunBallotAccess } from "../domain/dry-run-ballots";
import {
  createVotekickRepository,
  peekVotekickAdmission,
  peekVotekickCancel,
  peekVotekickFinalize,
  peekVotekickFinish,
  peekVotekickMarkLifted,
} from "./adapters/d1";
import type { VotekickRepository } from "./repository";
import { VOTEKICK_COMMAND_PATTERN } from "./domain";
import type { Votekick, VotekickSettings } from "./contracts";
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

const simulatedRepository = (context: ModuleDryRunContext, running: Votekick | null): VotekickRepository => {
  const repository = createVotekickRepository(context.DB);
  const updates = new Map<string, Partial<Votekick>>();
  return {
    ...repository,
    running: () => Promise.resolve(running),
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
      const update = updates.get(id);
      return current === null || update === undefined ? current : { ...current, ...update };
    },
    updateCounts: () => Promise.resolve(),
    finalize: async (channelId, id, status, yesVotes, noVotes, ballotRevision, durationSeconds, endedAt) => {
      if (!await peekVotekickFinalize(context.DB, channelId, id)) return false;
      updates.set(id, { status, yesVotes, noVotes, ballotRevision, durationSeconds, endedAt });
      return true;
    },
    finish: async (channelId, id, status, yesVotes, noVotes, ballotRevision, durationSeconds, endedAt) => {
      if (!await peekVotekickFinish(context.DB, channelId, id, status, ballotRevision)) return false;
      const current = await repository.byId(channelId, id);
      if (current === null) return false;
      const updateCounts = ballotRevision !== null && current.ballotRevision < ballotRevision;
      updates.set(id, {
        status,
        ...(updateCounts ? { yesVotes, noVotes, ballotRevision } : {}),
        durationSeconds,
        endedAt,
      });
      return true;
    },
    cancel: async (channelId, id, now) => {
      const cancelled = await peekVotekickCancel(context.DB, channelId, id, now);
      if (cancelled !== null) updates.set(id, cancelled);
      return cancelled;
    },
    markLifted: async (channelId, id, now) => {
      const lifted = await peekVotekickMarkLifted(context.DB, channelId, id);
      if (lifted) updates.set(id, { ...updates.get(id), liftedAt: now, liftClaimedAt: null });
      return lifted;
    },
  };
};

const serviceContext = (
  context: ModuleDryRunContext,
  rules: ReadonlyMap<string, ReturnType<typeof votekickFinalizeRule>> = new Map(),
  ballots: ModuleBallotAccess = createDryRunBallotAccess(context, { initialRules: rules }),
): ModuleExecutionContext => ({
  ...context,
  authorizeMutation: () => { throw new Error("Dry-run cannot authorize channel mutations."); },
  ballots,
  scheduleAlarm: () => Promise.resolve(),
  clearAlarm: () => Promise.resolve(),
} as unknown as ModuleExecutionContext);

const chatEffect = (
  action: Extract<ModuleAction, { kind: "chat" }>,
  context: ModuleDryRunContext,
  attributions?: readonly string[],
  when?: "on_success" | "on_failure",
): DryRunEffect => ({
  kind: "chat",
  text: action.text,
  target: action.target ?? context.defaultChatTarget,
  postsTo: "this_chat",
  reply: action.replyToMessageId !== undefined,
  suppressedBy: null,
  automated: action.automated ?? false,
  ...(attributions === undefined || attributions.length === 0 ? {} : { attributions }),
  ...(when === undefined ? {} : { when }),
});

const actionEffects = (
  actions: readonly ModuleAction[],
  event: ModuleEvent<VotekickSettings>,
  context: ModuleDryRunContext,
  castResults: ReadonlyMap<string, BallotCastResult>,
  attributions: readonly string[] | undefined,
): DryRunEffect[] => {
  const text = messageText(event);
  const command = VOTEKICK_COMMAND_PATTERN.exec(text.trim());
  const choice = ballotChoiceFromMessage(text, 2);
  const timeout = actions.find((action): action is Extract<ModuleAction, { kind: "timeout" }> => action.kind === "timeout");
  const overlay = actions.find((action): action is Extract<ModuleAction, { kind: "overlay" }> => action.kind === "overlay");
  const effects: DryRunEffect[] = [];
  if (overlay?.type === "opened") {
    const target = Reflect.get(overlay.payload, "targetLogin");
    const votekickId = Reflect.get(overlay.payload, "votekickId");
    const starterVote = typeof votekickId === "string" ? castResults.get(votekickId) : undefined;
    effects.push({
      kind: "ballot",
      moduleId: "votekick",
      action: "start",
      label: typeof target === "string" ? target : command?.[1] ?? "Votekick",
      ...(starterVote?.status === "counted" || starterVote?.status === "changed" ? { counts: starterVote.counts } : {}),
    });
  } else if (overlay?.type === "tally") {
    const target = Reflect.get(overlay.payload, "targetLogin");
    const votekickId = Reflect.get(overlay.payload, "votekickId");
    const yes = Reflect.get(overlay.payload, "yesVotes");
    const no = Reflect.get(overlay.payload, "noVotes");
    const status = Reflect.get(overlay.payload, "status");
    const cast = typeof votekickId === "string" ? castResults.get(votekickId) : undefined;
    const counts = typeof yes === "number" && typeof no === "number" ? [yes, no] : undefined;
    if (cast?.status === "counted" || cast?.status === "changed") {
      effects.push({
        kind: "ballot",
        moduleId: "votekick",
        action: "count",
        label: typeof target === "string" ? target : "Votekick",
        choice: choice === 1 ? "yes" : "no",
        ...(counts === undefined ? {} : { counts }),
      });
    }
    if (timeout !== undefined || status === "passed" || status === "expired" || status === "cancelled") {
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
    if (action.kind === "chat") effects.push(chatEffect(action, context, attributions));
    if (action.kind === "timeout") {
      effects.push({
        kind: "timeout",
        minSeconds: event.settings.duration.minSeconds,
        maxSeconds: event.settings.duration.maxSeconds,
        reason: action.reason,
      });
      if (action.onSuccess?.kind === "chat") effects.push(chatEffect(action.onSuccess, context, attributions, "on_success"));
      if (action.onFailure?.kind === "chat") effects.push(chatEffect(action.onFailure, context, attributions, "on_failure"));
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
  const sourceRepository = createVotekickRepository(context.DB);
  // Pin D1 and ballot state at request start; concurrent changes are out of scope.
  const current = await sourceRepository.running(event.channelId);
  const repository = simulatedRepository(context, current);
  const rules = current === null ? new Map() : new Map([[current.id, votekickFinalizeRule(current.threshold)]]);
  const voter = Reflect.get(event.payload, "chatter_user_id");
  const castResults = new Map<string, BallotCastResult>();
  const ballots = createDryRunBallotAccess(context, {
    initialRules: rules,
    onCastResult: (ballotId, result) => castResults.set(ballotId, result),
    ...(typeof voter === "string" && voter.length > 0 ? { voterId: voter } : {}),
  });
  const initialSnapshot = current === null ? null : await ballots.readSnapshot?.(current.id) ?? null;
  const result: ModuleResult = await processVotekickMessage(event, repository, serviceContext(context, rules, ballots));
  const ballotChoiceUnresolved = context.isBallotChoiceUnresolved?.() === true && initialSnapshot?.isActive !== false;
  const targetLookupDeferred = command !== null &&
    context.isUserLookupDeferred?.((command[1] ?? "").toLowerCase()) === true;
  const rejected = result.diagnostics.find(({ code }) => code === "votekick.rejected");
  const rejectedDetail = rejected === undefined ? {} : diagnosticValues(rejected);
  const blocks = rejected === undefined || targetLookupDeferred || ballotChoiceUnresolved
    ? []
    : [{ code: blockCodeForReason(rejectedDetail.reason), detail: rejectedDetail }];
  const effects = targetLookupDeferred || ballotChoiceUnresolved
    ? []
    : actionEffects(result.actions, event, context, castResults, result.attributions);
  if (result.actions.length === 0 && result.diagnostics.length === 0 && effects.length === 0 &&
      !targetLookupDeferred && !ballotChoiceUnresolved) return [];
  if (command === null && choice === null && effects.length === 0 && blocks.length === 0) return [];
  const token = command === null ? choice === null ? "any chat message" : text.trim() : "!votekick";
  return [{
    moduleId: "votekick",
    entry: { kind: "votekick", id: "votekick-message", label: command === null ? token : text.trim() },
    outcome: targetLookupDeferred || ballotChoiceUnresolved ? "indeterminate" : blocks.length === 0 ? "fires" : "blocked",
    match: command === null && choice === null
      ? { kind: "keyword", pattern: "any chat message" }
      : { kind: "command_name", token },
    blocks,
    effects,
    templateNotes: [
      ...result.diagnostics.filter(({ code }) => code !== "votekick.rejected"),
      ...(targetLookupDeferred ? [{ code: "template.deferred_live", detail: { name: "votekick.target" } }] : []),
      ...(ballotChoiceUnresolved
        ? [{ code: "template.deferred_live", detail: { name: "ballot.previous_choice" } }]
        : []),
    ],
  }];
};
