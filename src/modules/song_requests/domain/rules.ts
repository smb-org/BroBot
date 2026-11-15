import type { ModuleChatStatus } from "../../contract";

export type SongRequestRoleThreshold = "everyone" | "subscriber" | "vip" | "moderator";

const ROLE_RANK: Readonly<Record<ModuleChatStatus, number>> = {
  viewer: 0,
  subscriber: 1,
  vip: 2,
  moderator: 3,
  broadcaster: 4,
};

const THRESHOLD_RANK: Readonly<Record<SongRequestRoleThreshold, number>> = {
  everyone: 0,
  subscriber: 1,
  vip: 2,
  moderator: 3,
};

export const canUseFreeSongRequest = (
  threshold: SongRequestRoleThreshold,
  statuses: readonly ModuleChatStatus[] | null,
): boolean => threshold === "everyone" || (statuses ?? []).some((status) => ROLE_RANK[status] >= THRESHOLD_RANK[threshold]);

export const isOpenSongRequestState = (state: unknown): boolean =>
  state === "pending_review" || state === "approved" || state === "submitting" || state === "submitted" || state === "outcome_unknown";