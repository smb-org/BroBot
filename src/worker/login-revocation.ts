import {
  clearPendingRealtimeUserRevocation,
  getPendingRealtimeUserRevocation,
  revokeLoginIdentityAndSessionsForUser,
  type LoginIdentityRecord,
} from "./db/login-identity";
import { revokeRealtimeUserFromAllChannels } from "./realtime";
import { notifyCommittedResources } from "./panel-resources";

export const markLoginRevoked = async (
  env: { DB: D1Database; CHANNEL?: Env["CHANNEL"] | undefined },
  identity: LoginIdentityRecord,
  now: string,
  reason: string,
  refreshLease?: { owner: string; now: number },
): Promise<boolean> => {
  const revoked = await revokeLoginIdentityAndSessionsForUser(
    env.DB,
    identity.userId,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    reason,
    now,
    refreshLease,
  );
  if (!revoked) return false;

  const pending = await getPendingRealtimeUserRevocation(env.DB, identity.userId);
  if (env.CHANNEL !== undefined) {
    await revokeRealtimeUserFromAllChannels(env.DB, env.CHANNEL, identity.userId);
    if (pending !== null) await clearPendingRealtimeUserRevocation(env.DB, pending);
    await notifyCommittedResources({ DB: env.DB, CHANNEL: env.CHANNEL });
  }
  return true;
};
