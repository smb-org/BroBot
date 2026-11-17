export type SkipVoteDecision = "skip" | "threshold_not_met" | "no_majority";

export const decideSkipVote = (yesVotes: number, noVotes: number, threshold: number): SkipVoteDecision => {
  if (yesVotes < threshold) return "threshold_not_met";
  return yesVotes > noVotes ? "skip" : "no_majority";
};
