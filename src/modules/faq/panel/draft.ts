import { templateTextLength } from "../../../contracts/template-text-length";
import type { FaqEntry, FaqGame, FaqMutationInput } from "../contracts";
import { FAQ_ANSWER_MAX_LENGTH, FAQ_COOLDOWN_MAXIMUM_SECONDS, FAQ_COOLDOWN_MINIMUM_SECONDS, FAQ_PATTERN_MAXIMUM_COUNT, FAQ_PATTERN_MAX_LENGTH } from "../contracts";

export interface FaqDraft {
  name: string;
  patterns: string;
  answerText: string;
  cooldownSeconds: number | "";
  games: FaqGame[];
  chatTarget: FaqEntry["chatTarget"];
}

export const inputFromDraft = (draft: FaqDraft): FaqMutationInput | null => {
  const patterns = draft.patterns.split("\n").map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  if (draft.name.trim().length === 0 || draft.answerText.trim().length === 0 || templateTextLength(draft.answerText) > FAQ_ANSWER_MAX_LENGTH || patterns.length === 0 ||
      patterns.length > FAQ_PATTERN_MAXIMUM_COUNT || patterns.some((pattern) => pattern.length > FAQ_PATTERN_MAX_LENGTH) ||
      typeof draft.cooldownSeconds !== "number" || !Number.isInteger(draft.cooldownSeconds) ||
      draft.cooldownSeconds < FAQ_COOLDOWN_MINIMUM_SECONDS || draft.cooldownSeconds > FAQ_COOLDOWN_MAXIMUM_SECONDS) return null;
  return {
    name: draft.name.trim(),
    matcher: { type: "keywords", patterns },
    answerText: draft.answerText,
    cooldownSeconds: draft.cooldownSeconds,
    games: draft.games,
    chatTarget: draft.chatTarget,
  };
};
