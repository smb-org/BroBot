export const CHAT_VOTE_PALETTE = [
  "#5b8cff",
  "#ff9f43",
  "#2ed3a3",
  "#ff6fae",
  "#ffd45c",
  "#a47bff",
] as const;

const ALL_CHAT_VOTE_COLORS = [...CHAT_VOTE_PALETTE, "#68aeff", "#ff665c", "#c3ccdd"] as const;
const MINIMUM_VOTE_COLOR_CONTRAST = 3;

type VoteColorContrastTarget = "cockpit" | "overlayTrack";

const CONTRAST_BACKGROUNDS: Readonly<Record<VoteColorContrastTarget, readonly string[]>> = {
  cockpit: ["#1c222b", "#1b2843"],
  overlayTrack: ["#202020"],
};

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
};

const contrastRatio = (foreground: string, background: string): number => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
};

export const normalizeChatVoteColor = (value: string): string | null =>
  /^#[\da-f]{6}$/iu.test(value) ? value.toLowerCase() : null;

export const chatVoteDefaultColorAt = (index: number): string => ALL_CHAT_VOTE_COLORS[index] ?? CHAT_VOTE_PALETTE[index % CHAT_VOTE_PALETTE.length] ?? CHAT_VOTE_PALETTE[0];

export const chatVoteDefaultColors = (count: number): string[] =>
  Array.from({ length: Math.max(0, Math.min(9, count)) }, (_, index) => chatVoteDefaultColorAt(index));

export const voteColorContrastRatio = (color: string, target: VoteColorContrastTarget): number => {
  const normalized = normalizeChatVoteColor(color);
  if (normalized === null) return 0;
  return Math.min(...CONTRAST_BACKGROUNDS[target].map((background) => contrastRatio(normalized, background)));
};

export const voteColorContrastIssue = (color: string): "format" | "contrast" | null => {
  if (normalizeChatVoteColor(color) === null) return "format";
  return voteColorContrastRatio(color, "cockpit") < MINIMUM_VOTE_COLOR_CONTRAST ||
    voteColorContrastRatio(color, "overlayTrack") < MINIMUM_VOTE_COLOR_CONTRAST ? "contrast" : null;
};

export const isNormalizedChatVoteColor = (value: unknown): value is string =>
  typeof value === "string" && normalizeChatVoteColor(value) === value && voteColorContrastIssue(value) === null;
