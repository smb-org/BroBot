import type {
  ChannelStreamState,
  ImmediateActionRequirement,
  ImmediateActionUnavailableReason,
} from "../contracts/values";

type StreamState = ChannelStreamState | null | undefined;

type AvailabilityCheck = (streamState: StreamState) => ImmediateActionUnavailableReason | null;

const availabilityChecks: Record<ImmediateActionRequirement, AvailabilityCheck> = {
  streamLive: (streamState) => streamState === "online"
    ? null
    : streamState === "offline" ? "stream_offline" : "stream_state_unknown",
};

export interface ImmediateActionAvailability {
  enabled: boolean;
  reason: ImmediateActionUnavailableReason | null;
}

export const evaluateImmediateActionAvailability = (
  requirements: readonly ImmediateActionRequirement[],
  streamState: StreamState,
): ImmediateActionAvailability => {
  for (const requirement of requirements) {
    const reason = availabilityChecks[requirement](streamState);
    if (reason !== null) return { enabled: false, reason };
  }
  return { enabled: true, reason: null };
};
