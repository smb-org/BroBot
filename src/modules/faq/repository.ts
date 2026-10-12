import type { FaqEntry } from "./contracts";
import type { PreparedFaqMatcher } from "./domain";

export type FaqClaimResult =
  | { claimed: true; claimedAt: string }
  | { claimed: false; reason: "cooldown" | "person_cooldown"; remainingSeconds: number }
  | { claimed: false; reason: "changed" };

export interface FaqRepository {
  list(channelId: string): Promise<FaqEntry[]>;
  matchers(channelId: string, now?: number): Promise<readonly PreparedFaqMatcher[]>;
  claim(channelId: string, entry: FaqEntry, userId: string | null, now: string): Promise<FaqClaimResult>;
  releaseClaim(channelId: string, entry: FaqEntry, userId: string | null, claimedAt: string): Promise<void>;
  invalidate(channelId: string): void;
}
