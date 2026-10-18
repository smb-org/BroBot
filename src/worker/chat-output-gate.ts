export type ChatOutputSuppressionReason = "module_disabled" | "channel_paused" | "channel_muted";

export const chatOutputSuppressionReason = (input: {
  moduleEnabled: boolean;
  mandatory: boolean;
  paused: boolean;
  muted: boolean;
}): ChatOutputSuppressionReason | null => {
  if (!input.moduleEnabled) return "module_disabled";
  if (input.paused && !input.mandatory) return "channel_paused";
  if (input.muted) return "channel_muted";
  return null;
};

export const moderationOutputSuppressionReason = (input: {
  paused: boolean;
  muted: boolean;
}): "channel_paused" | "channel_muted" | null => {
  if (input.muted) return "channel_muted";
  if (input.paused) return "channel_paused";
  return null;
};
