export const OVERLAY_STYLE_BEGIN_MARKER = "/* brobot:style:begin - managed by the style editor, changes here are overwritten */";
export const OVERLAY_STYLE_END_MARKER = "/* brobot:style:end */";

export interface OverlayStyleStroke {
  width: number;
  color: string;
}

export interface OverlayStyleShadow {
  x: number;
  y: number;
  blur: number;
  color: string;
}

export interface OverlayStyleBackground {
  color: string;
  opacityPercent: number;
}

export type OverlayStyleAlignment = "left" | "center" | "right";

export interface OverlayStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 400 | 500 | 600 | 700;
  color?: string;
  textAlign?: OverlayStyleAlignment;
  lineHeight?: number;
  letterSpacing?: number;
  stroke?: OverlayStyleStroke;
  shadow?: OverlayStyleShadow;
  background?: OverlayStyleBackground;
  padding?: number;
  borderRadius?: number;
}

export interface OverlayStyleDocument {
  overlay: OverlayStyle;
  elements: Readonly<Record<string, OverlayStyle>>;
}

export type ParsedOverlayStyleBlock =
  | { kind: "missing" }
  | { kind: "valid"; styles: OverlayStyleDocument; contentStart: number; contentEnd: number }
  | { kind: "invalid"; contentStart: number | null; contentEnd: number | null };

const propertyOrder = [
  "font-family",
  "font-size",
  "font-weight",
  "color",
  "text-align",
  "line-height",
  "letter-spacing",
  "-webkit-text-stroke",
  "text-shadow",
  "background-color",
  "padding",
  "border-radius",
] as const;

const markerPrefixStartPattern = /\/\*\s*brobot:style:(?:begin|end)\b/gu;
const elementIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const hexColorPattern = /^#[0-9a-f]{6}$/u;

const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  const rendered = String(Object.is(value, -0) ? 0 : value);
  if (!rendered.includes("e")) return rendered;
  const [coefficient = "0", exponentText = "0"] = rendered.split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const point = unsigned.indexOf(".");
  const decimalPosition = (point < 0 ? unsigned.length : point) + exponent;
  const digits = unsigned.replace(".", "");
  const expanded = decimalPosition <= 0
    ? `0.${"0".repeat(-decimalPosition)}${digits}`
    : decimalPosition >= digits.length
      ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
      : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return negative ? `-${expanded}` : expanded;
};

const isSafeFontFamily = (value: string): boolean => value.length > 0 && value.length <= 80
  && !/[\r\n]/u.test(value) && !value.includes(String.fromCodePoint(0));
const normalizedColor = (value: string): string | null => hexColorPattern.test(value.toLowerCase()) ? value.toLowerCase() : null;

const escapeFontFamily = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
const unescapeFontFamily = (value: string): string | null => {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) return null;
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined || (next !== "\\" && next !== '"')) return null;
    output += next;
    index += 1;
  }
  return isSafeFontFamily(output) ? output : null;
};

const styleDeclarations = (style: OverlayStyle): readonly string[] => {
  const declarations = new Map<string, string>();
  if (style.fontFamily !== undefined && isSafeFontFamily(style.fontFamily)) {
    declarations.set("font-family", `"${escapeFontFamily(style.fontFamily)}", system-ui, sans-serif`);
  }
  if (style.fontSize !== undefined && Number.isFinite(style.fontSize) && style.fontSize >= 1 && style.fontSize <= 500) {
    declarations.set("font-size", `${formatNumber(style.fontSize)}px`);
  }
  if (style.fontWeight !== undefined && [400, 500, 600, 700].includes(style.fontWeight)) {
    declarations.set("font-weight", String(style.fontWeight));
  }
  const color = style.color === undefined ? null : normalizedColor(style.color);
  if (color !== null) declarations.set("color", color);
  if (style.textAlign !== undefined && ["left", "center", "right"].includes(style.textAlign)) {
    declarations.set("text-align", style.textAlign);
  }
  if (style.lineHeight !== undefined && Number.isFinite(style.lineHeight) && style.lineHeight >= 0.5 && style.lineHeight <= 3) {
    declarations.set("line-height", formatNumber(style.lineHeight));
  }
  if (style.letterSpacing !== undefined && Number.isFinite(style.letterSpacing) && style.letterSpacing >= -100 && style.letterSpacing <= 100) {
    declarations.set("letter-spacing", `${formatNumber(style.letterSpacing)}px`);
  }
  if (style.stroke !== undefined && Number.isFinite(style.stroke.width) && style.stroke.width > 0 && style.stroke.width <= 20) {
    const strokeColor = normalizedColor(style.stroke.color);
    if (strokeColor !== null) declarations.set("-webkit-text-stroke", `${formatNumber(style.stroke.width)}px ${strokeColor}`);
  }
  if (style.shadow !== undefined
    && Number.isFinite(style.shadow.x) && style.shadow.x >= -100 && style.shadow.x <= 100
    && Number.isFinite(style.shadow.y) && style.shadow.y >= -100 && style.shadow.y <= 100
    && Number.isFinite(style.shadow.blur) && style.shadow.blur >= 0 && style.shadow.blur <= 100) {
    const shadowColor = normalizedColor(style.shadow.color);
    if (shadowColor !== null) declarations.set("text-shadow", `${formatNumber(style.shadow.x)}px ${formatNumber(style.shadow.y)}px ${formatNumber(style.shadow.blur)}px ${shadowColor}`);
  }
  if (style.background !== undefined && Number.isInteger(style.background.opacityPercent) && style.background.opacityPercent >= 0 && style.background.opacityPercent <= 100) {
    const backgroundColor = normalizedColor(style.background.color);
    if (backgroundColor !== null) {
      const red = Number.parseInt(backgroundColor.slice(1, 3), 16);
      const green = Number.parseInt(backgroundColor.slice(3, 5), 16);
      const blue = Number.parseInt(backgroundColor.slice(5, 7), 16);
      declarations.set("background-color", `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${formatNumber(style.background.opacityPercent / 100)})`);
    }
  }
  if (style.padding !== undefined && Number.isFinite(style.padding) && style.padding >= 0 && style.padding <= 100) {
    declarations.set("padding", `${formatNumber(style.padding)}px`);
  }
  if (style.borderRadius !== undefined && Number.isFinite(style.borderRadius) && style.borderRadius >= 0 && style.borderRadius <= 100) {
    declarations.set("border-radius", `${formatNumber(style.borderRadius)}px`);
  }
  return propertyOrder.flatMap((property) => {
    const value = declarations.get(property);
    return value === undefined ? [] : [`  ${property}: ${value};`];
  });
};

const hasStyle = (style: OverlayStyle): boolean => styleDeclarations(style).length > 0;

const anchorTranslation = (alignment: OverlayStyleAlignment): string =>
  alignment === "center" ? "-50%" : alignment === "right" ? "-100%" : "0%";

const anchorRule = (selector: string, alignment: OverlayStyleAlignment): string =>
  `${selector} {\n  --brobot-overlay-anchor-x: ${anchorTranslation(alignment)};\n}`;

const styleRules = (styles: OverlayStyleDocument): readonly string[] => {
  const rules: string[] = [];
  if (hasStyle(styles.overlay)) {
    rules.push(`.brobot-overlay :where(.brobot-variable) {\n${styleDeclarations(styles.overlay).join("\n")}\n}`);
    if (styles.overlay.textAlign !== undefined) {
      rules.push(anchorRule(".brobot-overlay .brobot-overlay-composition-element", styles.overlay.textAlign));
    }
  }
  for (const elementId of Object.keys(styles.elements).filter((id) => elementIdPattern.test(id)).sort()) {
    const style = styles.elements[elementId];
    if (style !== undefined && hasStyle(style)) {
      rules.push(`[data-element="${elementId}"] :where(.brobot-variable) {\n${styleDeclarations(style).join("\n")}\n}`);
      if (style.textAlign !== undefined) {
        rules.push(anchorRule(`.brobot-overlay .brobot-overlay-composition-element[data-element="${elementId}"]`, style.textAlign));
      }
    }
  }
  return rules;
};

export const generateOverlayStyleContent = (styles: OverlayStyleDocument): string => styleRules(styles).join("\n\n");

export const generateOverlayStyleBlock = (styles: OverlayStyleDocument): string =>
  `${OVERLAY_STYLE_BEGIN_MARKER}\n${generateOverlayStyleContent(styles)}\n${OVERLAY_STYLE_END_MARKER}`;

const parseColor = (value: string): string | null => normalizedColor(value);

const parsePx = (value: string, minimum: number, maximum: number): number | null => {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?px$/u.exec(value);
  if (match === null) return null;
  const parsed = Number(value.slice(0, -2));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

const parseUnitless = (value: string, minimum: number, maximum: number): number | null => {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value);
  if (match === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
};

const parseDeclarations = (lines: readonly string[]): OverlayStyle | null => {
  const style: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: 400 | 500 | 600 | 700;
    color?: string;
    textAlign?: OverlayStyleAlignment;
    lineHeight?: number;
    letterSpacing?: number;
    stroke?: OverlayStyleStroke;
    shadow?: OverlayStyleShadow;
    background?: OverlayStyleBackground;
    padding?: number;
    borderRadius?: number;
  } = {};
  const seen = new Set<string>();
  let previousOrder = -1;
  for (const line of lines) {
    const declaration = /^ {2}([a-z-]+): (.+);$/u.exec(line);
    if (declaration === null) return null;
    const [, property, value] = declaration;
    if (property === undefined || value === undefined) return null;
    const order = propertyOrder.indexOf(property as (typeof propertyOrder)[number]);
    if (order < 0 || order <= previousOrder || seen.has(property)) return null;
    previousOrder = order;
    seen.add(property);
    switch (property) {
      case "font-family": {
        const match = /^"((?:[^"\\]|\\["\\])*)", system-ui, sans-serif$/u.exec(value);
        const family = match?.[1] === undefined ? null : unescapeFontFamily(match[1]);
        if (family === null) return null;
        style.fontFamily = family;
        break;
      }
      case "font-size": {
        const size = parsePx(value, 1, 500);
        if (size === null) return null;
        style.fontSize = size;
        break;
      }
      case "font-weight":
        if (value !== "400" && value !== "500" && value !== "600" && value !== "700") return null;
        style.fontWeight = Number(value) as 400 | 500 | 600 | 700;
        break;
      case "color": {
        const parsed = parseColor(value);
        if (parsed === null) return null;
        style.color = parsed;
        break;
      }
      case "text-align":
        if (value !== "left" && value !== "center" && value !== "right") return null;
        style.textAlign = value;
        break;
      case "line-height": {
        const lineHeight = parseUnitless(value, 0.5, 3);
        if (lineHeight === null) return null;
        style.lineHeight = lineHeight;
        break;
      }
      case "letter-spacing": {
        const spacing = parsePx(value, -100, 100);
        if (spacing === null) return null;
        style.letterSpacing = spacing;
        break;
      }
      case "-webkit-text-stroke": {
        const match = /^(0|[1-9]\d*)(?:\.(\d+))?px (#[0-9a-f]{6})$/u.exec(value);
        const width = match?.[1] === undefined ? null : parsePx(`${match[1]}${match[2] === undefined ? "" : `.${match[2]}`}px`, Number.MIN_VALUE, 20);
        const color = match?.[3] === undefined ? null : parseColor(match[3]);
        if (width === null || color === null) return null;
        style.stroke = { width, color };
        break;
      }
      case "text-shadow": {
        const match = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)px (-?(?:0|[1-9]\d*)(?:\.\d+)?)px (0|(?:0|[1-9]\d*)(?:\.\d+)?)px (#[0-9a-f]{6})$/u.exec(value);
        if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) return null;
        const x = parsePx(`${match[1]}px`, -100, 100);
        const y = parsePx(`${match[2]}px`, -100, 100);
        const blur = parsePx(`${match[3]}px`, 0, 100);
        const color = parseColor(match[4]);
        if (x === null || y === null || blur === null || color === null) return null;
        style.shadow = { x, y, blur, color };
        break;
      }
      case "background-color": {
        const match = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (0|1|0\.\d+)\)$/u.exec(value);
        if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) return null;
        const channels = [Number(match[1]), Number(match[2]), Number(match[3])];
        const opacity = match[4];
        const opacityDigits = /^0\.(\d{1,2})$/u.exec(opacity)?.[1];
        const opacityPercent = opacity === "0" ? 0
          : opacity === "1" ? 100
            : opacityDigits === undefined ? null : Number(opacityDigits.padEnd(2, "0"));
        if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255) || opacityPercent === null) return null;
        style.background = {
          color: `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
          opacityPercent,
        };
        break;
      }
      case "padding": {
        const padding = parsePx(value, 0, 100);
        if (padding === null) return null;
        style.padding = padding;
        break;
      }
      case "border-radius": {
        const radius = parsePx(value, 0, 100);
        if (radius === null) return null;
        style.borderRadius = radius;
        break;
      }
      default:
        return null;
    }
  }
  return lines.length === 0 ? null : style;
};

const parseContent = (content: string): OverlayStyleDocument | null => {
  if (!content.startsWith("\n") || !content.endsWith("\n")) return null;
  const body = content.slice(1, -1);
  if (body.length === 0) return { overlay: {}, elements: {} };
  const styles: { overlay: OverlayStyle; elements: Record<string, OverlayStyle> } = { overlay: {}, elements: {} };
  const rules = body.split("\n\n");
  let previousSelectorOrder = "";
  let overlayStyleSeen = false;
  for (const rule of rules) {
    const lines = rule.split("\n");
    const selectorLine = lines.shift();
    const overlayStyleSelector = selectorLine === ".brobot-overlay :where(.brobot-variable) {";
    const overlayAnchorSelector = selectorLine === ".brobot-overlay .brobot-overlay-composition-element {";
    const elementStyleMatch = selectorLine === undefined ? null : /^\[data-element="([A-Za-z0-9_-]{1,64})"\] :where\(\.brobot-variable\) \{$/u.exec(selectorLine);
    const elementAnchorMatch = selectorLine === undefined ? null : /^\.brobot-overlay \.brobot-overlay-composition-element\[data-element="([A-Za-z0-9_-]{1,64})"\] \{$/u.exec(selectorLine);
    if (!overlayStyleSelector && !overlayAnchorSelector && elementStyleMatch === null && elementAnchorMatch === null) return null;
    const closing = lines.pop();
    if (closing !== "}") return null;
    if (overlayAnchorSelector || elementAnchorMatch !== null) {
      const anchorLine = lines.length === 1 ? lines[0] : undefined;
      const anchorMatch = anchorLine === undefined ? null : /^ {2}--brobot-overlay-anchor-x: (0%|-50%|-100%);$/u.exec(anchorLine);
      if (anchorMatch === null || anchorMatch[1] === undefined) return null;
      const alignment = anchorMatch[1] === "-50%" ? "center" : anchorMatch[1] === "-100%" ? "right" : "left";
      const currentAlignment = overlayAnchorSelector
        ? styles.overlay.textAlign
        : elementAnchorMatch?.[1] === undefined ? undefined : styles.elements[elementAnchorMatch[1]]?.textAlign;
      if (currentAlignment !== alignment) return null;
      continue;
    }
    const parsed = parseDeclarations(lines);
    if (parsed === null) return null;
    if (overlayStyleSelector) {
      if (overlayStyleSeen) return null;
      styles.overlay = parsed;
      overlayStyleSeen = true;
    } else {
      const elementId = elementStyleMatch?.[1];
      if (elementId === undefined || Object.hasOwn(styles.elements, elementId)) return null;
      styles.elements[elementId] = parsed;
      if (previousSelectorOrder !== "" && elementId <= previousSelectorOrder) return null;
      previousSelectorOrder = elementId;
    }
  }
  return generateOverlayStyleContent(styles) === body ? styles : null;
};

export const parseOverlayStyleBlock = (css: string): ParsedOverlayStyleBlock => {
  const exactBegins = Array.from(css.matchAll(new RegExp(OVERLAY_STYLE_BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")));
  const exactEnds = Array.from(css.matchAll(new RegExp(OVERLAY_STYLE_END_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")));
  const markerLike = Array.from(css.matchAll(markerPrefixStartPattern));
  if (exactBegins.length === 0 && exactEnds.length === 0 && markerLike.length === 0) return { kind: "missing" };
  if (exactBegins.length !== 1 || exactEnds.length !== 1 || markerLike.length !== 2) return { kind: "invalid", contentStart: null, contentEnd: null };
  const begin = exactBegins[0];
  const end = exactEnds[0];
  if (begin === undefined || end === undefined) return { kind: "invalid", contentStart: null, contentEnd: null };
  const contentStart = begin.index + OVERLAY_STYLE_BEGIN_MARKER.length;
  const contentEnd = end.index;
  const beforeBegin = css.slice(0, begin.index);
  const afterEnd = css.slice(end.index + OVERLAY_STYLE_END_MARKER.length);
  if (contentEnd <= contentStart || (beforeBegin.length > 0 && !beforeBegin.endsWith("\n"))
    || (afterEnd.length > 0 && !afterEnd.startsWith("\n") && !afterEnd.startsWith("\r\n"))) {
    return { kind: "invalid", contentStart: null, contentEnd: null };
  }
  const parsed = parseContent(css.slice(contentStart, contentEnd));
  if (parsed === null) return { kind: "invalid", contentStart, contentEnd };
  return { kind: "valid", styles: parsed, contentStart, contentEnd };
};

export const replaceOverlayStyleBlock = (
  css: string,
  styles: OverlayStyleDocument,
  elementIds: readonly string[],
): string => {
  const managedStyles: OverlayStyleDocument = {
    overlay: styles.overlay,
    elements: Object.fromEntries(elementIds
      .filter((elementId) => elementIdPattern.test(elementId))
      .sort()
      .flatMap((elementId) => styles.elements[elementId] === undefined ? [] : [[elementId, styles.elements[elementId]]])),
  };
  const content = generateOverlayStyleContent(managedStyles);
  const parsed = parseOverlayStyleBlock(css);
  if (parsed.kind === "valid" || (parsed.kind === "invalid" && parsed.contentStart !== null && parsed.contentEnd !== null)) {
    const contentStart = parsed.contentStart;
    const contentEnd = parsed.contentEnd;
    if (contentStart === null || contentEnd === null) return css;
    return `${css.slice(0, contentStart)}\n${content}\n${css.slice(contentEnd)}`;
  }
  if (parsed.kind === "invalid") return css;
  return `${generateOverlayStyleBlock(managedStyles)}\n${css}`;
};
