import type { Votekick, VotekickStatus } from "./contracts";

export interface VotekickStart {
  id: string;
  targetUserId: string;
  targetLogin: string;
  initiatorUserId: string;
  threshold: number;
  startedAt: string;
  endsAt: string;
}

export interface VotekickRepository {
  channelEndedAt(channelId: string): Promise<string | null>;
  targetStartedAt(channelId: string, targetUserId: string): Promise<string | null>;
  insertRunning(channelId: string, input: VotekickStart): Promise<boolean>;
  running(channelId: string): Promise<Votekick | null>;
  listRecent(channelId: string, since: string): Promise<readonly Votekick[]>;
  updateCounts(channelId: string, id: string, yesVotes: number, noVotes: number): Promise<void>;
  finish(
    channelId: string,
    id: string,
    status: Exclude<VotekickStatus, "running">,
    yesVotes: number,
    noVotes: number,
    durationSeconds: number | null,
    endedAt: string,
  ): Promise<boolean>;
  cancel(channelId: string, id: string, now: string): Promise<Votekick | null>;
  markLifted(channelId: string, id: string, now: string): Promise<boolean>;
}
