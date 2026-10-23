import type {
  ChannelStreamState,
  ImmediateActionUnavailableReason,
} from "../contracts/values";
import type { ModuleImmediateActionCondition } from "../modules/contract";

type StreamState = ChannelStreamState | null | undefined;

export interface ImmediateActionAvailability {
  enabled: boolean;
  reason: ImmediateActionUnavailableReason | null;
}

export const evaluateImmediateActionAvailability = (
  conditions: readonly ModuleImmediateActionCondition[],
  streamState: StreamState,
  moduleEnabled = true,
): ImmediateActionAvailability => {
  for (const condition of conditions) {
    if (condition === "moduleEnabled") {
      if (!moduleEnabled) return { enabled: false, reason: "module_disabled" };
      continue;
    }
    if (condition !== "streamLive") continue;
    const reason: ImmediateActionUnavailableReason | null = streamState === "online"
      ? null
      : streamState === "offline" ? "stream_offline" : "stream_state_unknown";
    if (reason !== null) return { enabled: false, reason };
  }
  return { enabled: true, reason: null };
};
