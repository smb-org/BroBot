import type { CSSProperties } from "react";

import type {
  JsonObject,
  ModuleOverlayAppearanceDefinition,
  OverlayAppearanceConfig,
  OverlayAppearancePart,
} from "../modules/contract";

const appearanceParts: readonly OverlayAppearancePart[] = ["background", "text", "secondaryText", "accent"];
const hexColorPattern = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu;
const rgbColorPattern = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*(0(?:\.\d+)?|1(?:\.0+)?|\d{1,2}%|100%))?\s*\)$/iu;

type ParsedColor = { red: number; green: number; blue: number; alpha: number };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const parseColor = (value: string): ParsedColor | null => {
  if (hexColorPattern.test(value)) {
    const red = Number.parseInt(value.slice(1, 3), 16);
    const green = Number.parseInt(value.slice(3, 5), 16);
    const blue = Number.parseInt(value.slice(5, 7), 16);
    const alpha = value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1;
    return { red, green, blue, alpha };
  }
  const match = rgbColorPattern.exec(value);
  if (match === null) return null;
  const red = Number(match[1]);
  const green = Number(match[2]);
  const blue = Number(match[3]);
  if ([red, green, blue].some((channel) => !Number.isInteger(channel) || channel > 255)) return null;
  const rawAlpha = match[4];
  const alpha = rawAlpha === undefined ? 1 : rawAlpha.endsWith("%")
    ? Number(rawAlpha.slice(0, -1)) / 100
    : Number(rawAlpha);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  return { red, green, blue, alpha };
};

export const isOverlayAppearanceColor = (value: unknown, allowTransparent = false): value is string =>
  typeof value === "string" && (allowTransparent && value === "transparent" || parseColor(value) !== null);

const validAppearanceDefinition = (definition: ModuleOverlayAppearanceDefinition): boolean =>
  definition.parts.length > 0 && definition.parts.every((part) => appearanceParts.includes(part) &&
    Object.hasOwn(definition.defaults, part) && isOverlayAppearanceColor(definition.defaults[part], part === "background"));

const parseOverlayAppearanceConfig = (
  rawConfig: unknown,
  definition: ModuleOverlayAppearanceDefinition,
): OverlayAppearanceConfig | null => {
  const source = record(rawConfig);
  if (source === null || !validAppearanceDefinition(definition)) return null;
  const nestedAppearance = source.appearance === undefined ? {} : record(source.appearance);
  if (nestedAppearance === null || Object.keys(nestedAppearance).some((key) => !definition.parts.includes(key as OverlayAppearancePart))) return null;

  const parsed: OverlayAppearanceConfig = {};
  for (const part of definition.parts) {
    const legacyField = definition.legacyFields?.[part];
    const hasNestedValue = Object.hasOwn(nestedAppearance, part);
    const hasLegacyValue = legacyField !== undefined && Object.hasOwn(source, legacyField);
    const value = hasNestedValue
      ? nestedAppearance[part]
      : hasLegacyValue ? source[legacyField] : definition.defaults[part];
    if (!isOverlayAppearanceColor(value, part === "background")) return null;
    parsed[part] = value;
  }
  return parsed;
};

export const parseOverlayElementConfig = (
  rawConfig: unknown,
  definition: ModuleOverlayAppearanceDefinition,
  parseSpecificConfig: (config: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | null,
): JsonObject | null => {
  const source = record(rawConfig);
  const appearance = parseOverlayAppearanceConfig(rawConfig, definition);
  if (source === null || appearance === null) return null;
  const legacyFields = new Set(Object.values(definition.legacyFields ?? {}));
  const specificConfig = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "appearance" && !legacyFields.has(key)));
  const specific = parseSpecificConfig(specificConfig);
  if (specific === null) return null;
  return { ...specific, appearance };
};

export const overlayAppearanceStyle = (value: unknown): CSSProperties => {
  const appearance = record(value);
  if (appearance === null) return {};
  const style: Record<string, string> = {};
  for (const part of appearanceParts) {
    const color = appearance[part];
    if (!isOverlayAppearanceColor(color, part === "background")) continue;
    const property = part === "secondaryText" ? "secondary-text" : part;
    style[`--overlay-appearance-${property}`] = color;
  }
  return style;
};

export const overlayAppearanceToJsonObject = (value: OverlayAppearanceConfig): JsonObject => {
  const appearance: Record<string, string> = {};
  for (const part of appearanceParts) {
    const color = value[part];
    if (typeof color === "string") appearance[part] = color;
  }
  return appearance;
};

const linearize = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const composite = (foreground: ParsedColor, background: ParsedColor): ParsedColor => {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  return {
    red: (foreground.red * foreground.alpha + background.red * background.alpha * (1 - foreground.alpha)) / alpha,
    green: (foreground.green * foreground.alpha + background.green * background.alpha * (1 - foreground.alpha)) / alpha,
    blue: (foreground.blue * foreground.alpha + background.blue * background.alpha * (1 - foreground.alpha)) / alpha,
    alpha,
  };
};

const luminance = ({ red, green, blue }: ParsedColor): number =>
  0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);

export const overlayAppearanceContrastRatio = (foreground: string, background: string): number | null => {
  if (background === "transparent") return null;
  const parsedForeground = parseColor(foreground);
  const parsedBackground = parseColor(background);
  if (parsedForeground === null || parsedBackground === null) return null;
  const opaqueBackdrop = composite(parsedBackground, { red: 0, green: 0, blue: 0, alpha: 1 });
  const visibleForeground = composite(parsedForeground, opaqueBackdrop);
  const values = [luminance(visibleForeground), luminance(opaqueBackdrop)].sort((left, right) => right - left);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
};

export const resolveOverlayAppearance = (
  value: unknown,
  definition: ModuleOverlayAppearanceDefinition,
): OverlayAppearanceConfig => parseOverlayAppearanceConfig({ appearance: value }, definition) ?? definition.defaults;
