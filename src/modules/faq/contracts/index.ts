import type { ChatOutputTarget } from "../../contract";

export const FAQ_MODULE_ID = "faq";
export const FAQ_ENTRY_MAXIMUM_COUNT = 100;
export const FAQ_ENTRY_NAME_MAX_LENGTH = 60;
export const FAQ_PATTERN_MAXIMUM_COUNT = 20;
export const FAQ_PATTERN_MAX_LENGTH = 80;
export const FAQ_COOLDOWN_MAXIMUM_SECONDS = 86_400;
export const FAQ_GAME_MAXIMUM_COUNT = 10;

export type FaqMatcher =
  | { type: "keywords"; patterns: readonly string[] }
  | { type: "regex"; pattern: string };

export type FaqMutationMatcher = Extract<FaqMatcher, { type: "keywords" }>;

export interface FaqGame {
  id: string;
  name: string;
  boxArtUrlTemplate?: string;
}

export interface FaqEntry {
  id: string;
  name: string;
  enabled: boolean;
  matcher: FaqMatcher;
  answerBlock: string;
  cooldownSeconds: number;
  games: readonly FaqGame[];
  chatTarget: ChatOutputTarget;
  order: number;
  revision: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FaqMutationInput {
  name: string;
  matcher: FaqMutationMatcher;
  answerBlock: string;
  cooldownSeconds: number;
  games: readonly FaqGame[];
  chatTarget: ChatOutputTarget;
}

export interface FaqMatch {
  entry: FaqEntry;
  matchedPattern: string;
}

export interface FaqMatchResult {
  match: FaqMatch | null;
  reason: "matched" | "no_match" | "command_prefix";
}
