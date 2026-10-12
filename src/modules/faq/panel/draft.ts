import { templateTextLength } from "../../../contracts/template-text-length";
import type { FaqEntry, FaqGame, FaqMatcher, FaqMutationInput } from "../contracts";
import { FAQ_ANSWER_MAX_LENGTH, FAQ_COOLDOWN_MAXIMUM_SECONDS, FAQ_COOLDOWN_MINIMUM_SECONDS, FAQ_PATTERN_MAXIMUM_COUNT, FAQ_PATTERN_MAX_LENGTH, FAQ_USER_COOLDOWN_MAXIMUM_SECONDS } from "../contracts";

export interface FaqDraft {
  name: string;
  matcherType: FaqMatcher["type"];
  patterns: string;
  answerText: string;
  cooldownSeconds: number | "";
  userCooldownSeconds: number | "";
  games: FaqGame[];
  chatTarget: FaqEntry["chatTarget"];
}

export const inputFromDraft = (draft: FaqDraft): FaqMutationInput | null => {
  const patterns = draft.patterns.split("\n").map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  const matcher: FaqMutationInput["matcher"] = draft.matcherType === "keywords"
    ? { type: "keywords", patterns }
    : { type: "regex", pattern: draft.patterns };
  const matcherInvalid = draft.matcherType === "keywords"
    ? patterns.length === 0 || patterns.length > FAQ_PATTERN_MAXIMUM_COUNT || patterns.some((pattern) => pattern.length > FAQ_PATTERN_MAX_LENGTH)
    : draft.patterns.trim().length === 0 || draft.patterns.length > FAQ_PATTERN_MAX_LENGTH;
  if (draft.name.trim().length === 0 || draft.answerText.trim().length === 0 || templateTextLength(draft.answerText) > FAQ_ANSWER_MAX_LENGTH || matcherInvalid ||
      typeof draft.cooldownSeconds !== "number" || !Number.isInteger(draft.cooldownSeconds) ||
      draft.cooldownSeconds < FAQ_COOLDOWN_MINIMUM_SECONDS || draft.cooldownSeconds > FAQ_COOLDOWN_MAXIMUM_SECONDS ||
      typeof draft.userCooldownSeconds !== "number" || !Number.isInteger(draft.userCooldownSeconds) ||
      draft.userCooldownSeconds < 0 || draft.userCooldownSeconds > FAQ_USER_COOLDOWN_MAXIMUM_SECONDS) return null;
  return {
    name: draft.name.trim(),
    matcher,
    answerText: draft.answerText,
    cooldownSeconds: draft.cooldownSeconds,
    userCooldownSeconds: draft.userCooldownSeconds,
    games: draft.games,
    chatTarget: draft.chatTarget,
  };
};
