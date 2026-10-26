import { VOTEKICK_LIFT_CLAIM_LEASE_MS } from "../contracts";
import type { Votekick } from "../contracts";

export const activeVotekickTimeouts = (votekicks: readonly Votekick[], serverNowValue: string): readonly Votekick[] => {
  const serverNow = Date.parse(serverNowValue);
  if (!Number.isFinite(serverNow)) return [];
  const staleClaimBefore = serverNow - VOTEKICK_LIFT_CLAIM_LEASE_MS;

  return votekicks.filter((item) => {
    const timeoutExpiresAt = item.endedAt === null || item.durationSeconds === null
      ? Number.NaN
      : Date.parse(item.endedAt) + item.durationSeconds * 1_000;
    const liftClaimedAt = item.liftClaimedAt === null ? Number.NaN : Date.parse(item.liftClaimedAt);
    const staleClaim = Number.isFinite(liftClaimedAt) && liftClaimedAt <= staleClaimBefore;
    return item.status === "passed"
      && item.liftedAt === null
      && item.targetUserId !== null
      && item.durationSeconds !== null
      && item.durationSeconds > 0
      && item.endedAt !== null
      && Number.isFinite(Date.parse(item.endedAt))
      && Number.isFinite(timeoutExpiresAt)
      && (staleClaim || (item.liftClaimedAt === null && timeoutExpiresAt > serverNow));
  });
};
