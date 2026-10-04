import type { ModuleChatStatus } from "../../contract";

export const VOTEKICK_COMMAND_PATTERN = /^!votekick\s+@?([a-z0-9_]{1,25})$/iu;

export const canStartVotekick = (statuses: readonly ModuleChatStatus[] | null): boolean =>
  statuses?.some((status) => status === "vip" || status === "moderator" || status === "broadcaster") ?? false;

export const votekickThreshold = (minNetVotes: number, percent: number, activeChatterCount: number): number => {
  if (!Number.isSafeInteger(minNetVotes) || minNetVotes < 1 ||
      !Number.isSafeInteger(percent) || percent < 1 || percent > 100 ||
      !Number.isSafeInteger(activeChatterCount) || activeChatterCount < 0) {
    throw new RangeError("Votekick threshold inputs are invalid.");
  }
  return Math.max(minNetVotes, Math.ceil(percent * activeChatterCount / 100));
};

export const isActiveVotekickTarget = (lastSeenAt: string | null, now: number, windowMs: number): boolean => {
  if (lastSeenAt === null) return false;
  const lastSeen = Date.parse(lastSeenAt);
  return Number.isFinite(lastSeen) && lastSeen <= now && now - lastSeen <= windowMs;
};

export const wasActiveBeforeVotekick = (firstSeenAt: string | null, startedAt: string): boolean =>
  firstSeenAt !== null && Number.isFinite(Date.parse(firstSeenAt)) && Date.parse(firstSeenAt) < Date.parse(startedAt);

export const remainingVotekickSeconds = (endsAt: string, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(endsAt) - now) / 1000));

export const votekickTimeoutReason = (yesVotes: number, noVotes: number, votekickId: string): string =>
  `Votekick (${String(yesVotes)}:${String(noVotes)}) · ${votekickId}`;
