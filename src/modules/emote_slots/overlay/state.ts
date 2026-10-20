import type { JsonObject, ModuleLanguage } from "../../contract";

export interface SlotOverlaySymbol {
  source: "emoji" | "twitch" | "seven_tv";
  code: string;
  twitchId?: string;
  sevenTvId?: string;
  missing?: boolean;
}

export interface SlotOverlayState {
  spinId: string;
  spunAt: string;
  login: string;
  language: ModuleLanguage;
  outcome: "win" | "loss" | "pair" | "jackpot";
  symbols: readonly [SlotOverlaySymbol, SlotOverlaySymbol, SlotOverlaySymbol];
  net: number;
  jackpot: number;
  jackpotHit: boolean;
}

export const SLOT_OVERLAY_EDITOR_PREVIEW_SPIN_ID = "overlay-editor-preview";

export const DEFAULT_SLOT_OVERLAY_CONFIG = {
  backgroundColor: "#090C10",
  textColor: "#F2F5F9",
  secondaryColor: "#C9D1DB",
  highlightColor: "#3FCF7F",
  borderColor: "#353E4B",
} as const;

export type SlotOverlayConfig = typeof DEFAULT_SLOT_OVERLAY_CONFIG;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value);

export const parseSlotOverlayConfig = (raw: unknown): SlotOverlayConfig | null => {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !Object.hasOwn(DEFAULT_SLOT_OVERLAY_CONFIG, key))) return null;
  const config = { ...DEFAULT_SLOT_OVERLAY_CONFIG, ...raw };
  return Object.values(config).every(isColor) ? config : null;
};

const isOverlaySymbol = (value: unknown): value is SlotOverlaySymbol => {
  if (!isRecord(value) || !(value.source === "emoji" || value.source === "twitch" || value.source === "seven_tv") ||
      typeof value.code !== "string" || value.code.length === 0 || value.code.length > 64) return false;
  if (value.twitchId !== undefined && (typeof value.twitchId !== "string" || value.twitchId.length > 64)) return false;
  if (value.sevenTvId !== undefined && (typeof value.sevenTvId !== "string" || value.sevenTvId.length > 64)) return false;
  if (value.missing !== undefined && typeof value.missing !== "boolean") return false;
  return true;
};

export const isSlotOverlayState = (value: unknown): value is SlotOverlayState => isRecord(value) &&
  typeof value.spinId === "string" && value.spinId.length > 0 && value.spinId.length <= 80 &&
  typeof value.spunAt === "string" && Number.isFinite(Date.parse(value.spunAt)) &&
  typeof value.login === "string" && value.login.length > 0 && value.login.length <= 64 &&
  (value.language === "de" || value.language === "en") &&
  (value.outcome === "win" || value.outcome === "loss" || value.outcome === "pair" || value.outcome === "jackpot") &&
  Array.isArray(value.symbols) && value.symbols.length === 3 && value.symbols.every(isOverlaySymbol) &&
  Number.isSafeInteger(value.net) && Number.isSafeInteger(value.jackpot) && (value.jackpot as number) >= 0 &&
  typeof value.jackpotHit === "boolean";

const mergeSlotOverlayState = (
  previous: SlotOverlayState | null,
  incoming: SlotOverlayState,
): SlotOverlayState => previous === null || Date.parse(incoming.spunAt) >= Date.parse(previous.spunAt)
  ? incoming
  : previous;

export const mergeSlotOverlayRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  if (!isSlotOverlayState(incoming)) return current ?? incoming;
  if (current !== null && !isSlotOverlayState(current)) return incoming;
  return mergeSlotOverlayState(current, incoming) as unknown as Readonly<Record<string, unknown>>;
};

const linearize = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (hex: string): number => {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
};

export const slotOverlayContrastRatio = (foreground: string, background: string): number => {
  const luminances = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left);
  return ((luminances[0] ?? 0) + 0.05) / ((luminances[1] ?? 0) + 0.05);
};

export const slotOverlayConfigToJson = (config: SlotOverlayConfig): JsonObject => config;
