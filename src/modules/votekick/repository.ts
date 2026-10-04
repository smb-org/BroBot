import type { Votekick, VotekickStatus } from "./contracts";

export interface VotekickStart {
  id: string;
  targetUserId: string;
  targetLogin: string;
  initiatorUserId: string;
  threshold: number;
  yesVotes: number;
  ballotRevision: number;
  startedAt: string;
  endsAt: string;
}

export type VotekickAdmissionResult = "admitted" | "busy" | "channel_cooldown" | "target_cooldown";

export interface VotekickRepository {
  admit(channelId: string, input: VotekickStart, checkedAt: string, channelCooldownSeconds: number, targetCooldownSeconds: number): Promise<VotekickAdmissionResult>;
  expireOverdue(channelId: string, now: string): Promise<readonly Votekick[]>;
  byId(channelId: string, id: string): Promise<Votekick | null>;
  running(channelId: string): Promise<Votekick | null>;
  listRecent(channelId: string, since: string): Promise<readonly Votekick[]>;
  updateCounts(channelId: string, id: string, yesVotes: number, noVotes: number, ballotRevision: number): Promise<void>;
  finish(
    channelId: string,
    id: string,
    status: Exclude<VotekickStatus, "running">,
    yesVotes: number,
    noVotes: number,
    ballotRevision: number | null,
    durationSeconds: number | null,
    endedAt: string,
  ): Promise<boolean>;
  cancel(channelId: string, id: string, now: string): Promise<Votekick | null>;
  markLifted(channelId: string, id: string, now: string): Promise<boolean>;
}
