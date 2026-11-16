import type { ModuleLanguage, ModuleOverlayAppearanceDefinition, OverlayAppearanceConfig } from "../../contract";
import { isOverlayAppearanceColor, parseOverlayElementConfig } from "../../../overlay/appearance";

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
  appearance: {
    background: "#090C10",
    text: "#F2F5F9",
    secondaryText: "#C9D1DB",
    accent: "#2ED3A3",
  },
  borderColor: "#353E4B",
} as const;

export const SLOT_OVERLAY_APPEARANCE = {
  parts: ["background", "text", "secondaryText", "accent"],
  defaults: DEFAULT_SLOT_OVERLAY_CONFIG.appearance,
  legacyFields: { background: "backgroundColor", text: "textColor", secondaryText: "secondaryColor", accent: "highlightColor" },
} satisfies ModuleOverlayAppearanceDefinition;

export type SlotOverlayConfig = {
  appearance: OverlayAppearanceConfig;
  borderColor: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseSlotOverlayConfig = (raw: unknown): SlotOverlayConfig | null => parseOverlayElementConfig(
  raw,
  SLOT_OVERLAY_APPEARANCE,
  (config) => {
    if (Object.keys(config).some((key) => key !== "borderColor")) return null;
    const borderColor = config.borderColor ?? DEFAULT_SLOT_OVERLAY_CONFIG.borderColor;
    return isOverlayAppearanceColor(borderColor) ? { borderColor } : null;
  },
) as unknown as SlotOverlayConfig | null;

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

