export const OVERLAY_STYLE_BEGIN_MARKER = "/* brobot:style:begin - managed by the style editor, changes here are overwritten */";
export const OVERLAY_STYLE_END_MARKER = "/* brobot:style:end */";

interface OverlayStyleStroke {
  width: number;
  color: string;
}

interface OverlayStyleShadow {
  x: number;
  y: number;
  blur: number;
  color: string;
}

interface OverlayStyleBackground {
  color: string;
  opacityPercent: number;
}

export type OverlayStyleAlignment = "left" | "center" | "right";

export interface OverlayStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 400 | 500 | 600 | 700;
  color?: string;
  secondaryTextColor?: string;
  accentColor?: string;
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
  "--brobot-overlay-secondary-text-color",
  "--brobot-overlay-accent-color",
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

// Code-point order keeps the generated block identical across browser locales.
const compareCodePoints = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
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
  const secondaryTextColor = style.secondaryTextColor === undefined ? null : normalizedColor(style.secondaryTextColor);
  if (secondaryTextColor !== null) declarations.set("--brobot-overlay-secondary-text-color", secondaryTextColor);
  const accentColor = style.accentColor === undefined ? null : normalizedColor(style.accentColor);
  if (accentColor !== null) declarations.set("--brobot-overlay-accent-color", accentColor);
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

const styleRootDeclarations = (style: OverlayStyle): readonly string[] => {
  const declarations: string[] = [];
  const addColor = (property: string, value: string | undefined): void => {
    const color = value === undefined ? null : normalizedColor(value);
    if (color !== null) declarations.push(`  ${property}: ${color};`);
  };
  addColor("--brobot-overlay-text-color", style.color);
  addColor("--brobot-overlay-secondary-text-color", style.secondaryTextColor);
  addColor("--brobot-overlay-accent-color", style.accentColor);
  if (style.fontFamily !== undefined && isSafeFontFamily(style.fontFamily)) {
    declarations.push(`  --brobot-overlay-font-family: "${escapeFontFamily(style.fontFamily)}", system-ui, sans-serif;`);
  }
  if (style.fontSize !== undefined && Number.isFinite(style.fontSize) && style.fontSize >= 1 && style.fontSize <= 500) {
    declarations.push(`  --brobot-overlay-font-size: ${formatNumber(style.fontSize)}px;`);
  }
  if (style.fontWeight !== undefined && [400, 500, 600, 700].includes(style.fontWeight)) {
    declarations.push(`  --brobot-overlay-font-weight: ${String(style.fontWeight)};`);
  }
  if (style.textAlign !== undefined && ["left", "center", "right"].includes(style.textAlign)) {
    declarations.push(`  --brobot-overlay-text-align: ${style.textAlign};`);
    declarations.push(`  text-align: ${style.textAlign};`);
  }
  if (style.lineHeight !== undefined && Number.isFinite(style.lineHeight) && style.lineHeight >= 0.5 && style.lineHeight <= 3) {
    declarations.push(`  --brobot-overlay-line-height: ${formatNumber(style.lineHeight)};`);
  }
  if (style.letterSpacing !== undefined && Number.isFinite(style.letterSpacing) && style.letterSpacing >= -100 && style.letterSpacing <= 100) {
    declarations.push(`  --brobot-overlay-letter-spacing: ${formatNumber(style.letterSpacing)}px;`);
  }
  if (style.stroke !== undefined && Number.isFinite(style.stroke.width) && style.stroke.width > 0 && style.stroke.width <= 20) {
    const color = normalizedColor(style.stroke.color);
    if (color !== null) declarations.push(`  --brobot-overlay-text-stroke: ${formatNumber(style.stroke.width)}px ${color};`);
  }
  if (style.shadow !== undefined
    && Number.isFinite(style.shadow.x) && style.shadow.x >= -100 && style.shadow.x <= 100
    && Number.isFinite(style.shadow.y) && style.shadow.y >= -100 && style.shadow.y <= 100
    && Number.isFinite(style.shadow.blur) && style.shadow.blur >= 0 && style.shadow.blur <= 100) {
    const color = normalizedColor(style.shadow.color);
    if (color !== null) declarations.push(`  --brobot-overlay-text-shadow: ${formatNumber(style.shadow.x)}px ${formatNumber(style.shadow.y)}px ${formatNumber(style.shadow.blur)}px ${color};`);
  }
  if (style.background !== undefined && Number.isInteger(style.background.opacityPercent) && style.background.opacityPercent >= 0 && style.background.opacityPercent <= 100) {
    const color = normalizedColor(style.background.color);
    if (color !== null) {
      const red = Number.parseInt(color.slice(1, 3), 16);
      const green = Number.parseInt(color.slice(3, 5), 16);
      const blue = Number.parseInt(color.slice(5, 7), 16);
      declarations.push(`  --brobot-overlay-background: rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${formatNumber(style.background.opacityPercent / 100)});`);
    }
  }
  if (style.padding !== undefined && Number.isFinite(style.padding) && style.padding >= 0 && style.padding <= 100) {
    declarations.push(`  --brobot-overlay-padding: ${formatNumber(style.padding)}px;`);
  }
  if (style.borderRadius !== undefined && Number.isFinite(style.borderRadius) && style.borderRadius >= 0 && style.borderRadius <= 100) {
    declarations.push(`  --brobot-overlay-border-radius: ${formatNumber(style.borderRadius)}px;`);
  }
  return declarations;
};

const hasStyle = (style: OverlayStyle): boolean => styleDeclarations(style).length > 0;

const anchorTranslation = (alignment: OverlayStyleAlignment): string =>
  alignment === "center" ? "-50%" : alignment === "right" ? "-100%" : "0%";

const anchorRule = (selector: string, alignment: OverlayStyleAlignment): string =>
  `${selector} {\n  --brobot-overlay-anchor-x: ${anchorTranslation(alignment)};\n}`;

const styleRules = (styles: OverlayStyleDocument, includeRootDeclarations = true): readonly string[] => {
  const rules: string[] = [];
  if (hasStyle(styles.overlay)) {
    const rootDeclarations = styleRootDeclarations(styles.overlay);
    if (includeRootDeclarations && rootDeclarations.length > 0) rules.push(`.brobot-overlay {\n${rootDeclarations.join("\n")}\n}`);
    rules.push(`.brobot-overlay :where(.brobot-variable, .brobot-module-text) {\n${styleDeclarations(styles.overlay).join("\n")}\n}`);
    if (styles.overlay.textAlign !== undefined) {
      rules.push(anchorRule(".brobot-overlay .brobot-overlay-composition-element", styles.overlay.textAlign));
    }
  }
  for (const elementId of Object.keys(styles.elements).filter((id) => elementIdPattern.test(id)).sort(compareCodePoints)) {
    const style = styles.elements[elementId];
    if (style !== undefined && hasStyle(style)) {
      const rootDeclarations = styleRootDeclarations(style);
      if (includeRootDeclarations && rootDeclarations.length > 0) rules.push(`[data-element="${elementId}"] {\n${rootDeclarations.join("\n")}\n}`);
      rules.push(`[data-element="${elementId}"] :where(.brobot-variable, .brobot-module-text) {\n${styleDeclarations(style).join("\n")}\n}`);
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
    secondaryTextColor?: string;
    accentColor?: string;
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
      case "--brobot-overlay-secondary-text-color": {
        const parsed = parseColor(value);
        if (parsed === null) return null;
        style.secondaryTextColor = parsed;
        break;
      }
      case "--brobot-overlay-accent-color": {
        const parsed = parseColor(value);
        if (parsed === null) return null;
        style.accentColor = parsed;
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
    const overlayStyleSelector = selectorLine === ".brobot-overlay :where(.brobot-variable, .brobot-module-text) {";
    const overlayRootSelector = selectorLine === ".brobot-overlay {";
    const overlayAnchorSelector = selectorLine === ".brobot-overlay .brobot-overlay-composition-element {";
    const elementStyleMatch = selectorLine === undefined ? null : /^\[data-element="([A-Za-z0-9_-]{1,64})"\] :where\(\.brobot-variable, \.brobot-module-text\) \{$/u.exec(selectorLine);
    const elementRootMatch = selectorLine === undefined ? null : /^\[data-element="([A-Za-z0-9_-]{1,64})"\] \{$/u.exec(selectorLine);
    const elementAnchorMatch = selectorLine === undefined ? null : /^\.brobot-overlay \.brobot-overlay-composition-element\[data-element="([A-Za-z0-9_-]{1,64})"\] \{$/u.exec(selectorLine);
    if (!overlayStyleSelector && !overlayRootSelector && !overlayAnchorSelector && elementStyleMatch === null && elementRootMatch === null && elementAnchorMatch === null) return null;
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
    if (overlayRootSelector || elementRootMatch !== null) continue;
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
  return generateOverlayStyleContent(styles) === body || styleRules(styles, false).join("\n\n") === body ? styles : null;
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
  const content = css.slice(contentStart, contentEnd);
  // Blocks emitted before module text existed used `.brobot-variable` alone.
  // Normalize only those exact generated selectors before parsing; an editor
  // write then regenerates the block with the current selector form.
  const normalizedContent = content
    .replaceAll(".brobot-overlay :where(.brobot-variable) {", ".brobot-overlay :where(.brobot-variable, .brobot-module-text) {")
    .replace(/(\[data-element="[A-Za-z0-9_-]{1,64}"\]) :where\(\.brobot-variable\) \{/gu,
      "$1 :where(.brobot-variable, .brobot-module-text) {");
  const parsed = parseContent(normalizedContent);
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
      .sort(compareCodePoints)
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

interface LegacyOverlayElementConfig {
  id: string;
  kind: string;
  config: Readonly<Record<string, unknown>>;
}

const legacyColorFields: Readonly<Record<string, readonly (readonly [string, keyof OverlayStyle])[]>> = {
  "quiz.session": [
    ["backgroundColor", "background"],
    ["textColor", "color"],
    ["secondaryColor", "secondaryTextColor"],
    ["accentColor", "accentColor"],
  ],
  "emote_slots.slot": [
    ["backgroundColor", "background"],
    ["textColor", "color"],
    ["secondaryColor", "secondaryTextColor"],
    ["highlightColor", "accentColor"],
  ],
  "overlay_alerts.alert": [["textColor", "color"]],
};

const defaultElementColors: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "ads.countdown": { background: "transparent", text: "rgba(255, 255, 255, 0.96)" },
  "belabox.status": { background: "transparent", text: "rgba(255, 255, 255, 0.96)" },
  "chat_voting.tally": { background: "transparent", text: "rgba(255, 255, 255, 0.96)" },
  "song_requests.now_playing": { background: "#0d1015", text: "#f2f5f9", secondaryText: "#c3cbd7", tertiaryText: "#a8b2c1", accent: "#1ed760" },
  "song_requests.queue": { background: "#0d1015", text: "#f2f5f9", secondaryText: "#c3cbd7", accent: "#8ab4ff" },
  "statistics.word_counter": { background: "#0d1015", text: "#f2f5f9", secondaryText: "#a8b2c1" },
  "statistics.word_ranking": { background: "#0d1015", text: "#f2f5f9", secondaryText: "#a8b2c1", accent: "#35557f" },
  "text_library.block": { background: "transparent", text: "rgba(255, 255, 255, 0.96)", secondaryText: "rgba(255, 255, 255, 0.78)" },
  "votekick.tally": { background: "transparent", text: "rgba(255, 255, 255, 0.96)" },
  "quiz.session": { background: "#10141b", text: "#f2f5f9", secondaryText: "#a8b2c1", accent: "#5fa4ff", correctText: "#32ca88" },
  "emote_slots.slot": { background: "#090C10", text: "#F2F5F9", secondaryText: "#C9D1DB", accent: "#2ED3A3" },
  "overlay_alerts.alert": { background: "rgb(16 20 27 / 84%)", text: "#ffffff" },
};

const contrastTextParts: Readonly<Record<string, readonly ("text" | "secondaryText" | "accent")[]>> = {
  "song_requests.now_playing": ["text", "secondaryText", "accent"],
  "song_requests.queue": ["text", "secondaryText"],
  "statistics.word_counter": ["text", "secondaryText"],
  "statistics.word_ranking": ["text", "secondaryText"],
  "text_library.block": ["text", "secondaryText"],
  "quiz.session": ["text", "secondaryText", "accent"],
  "emote_slots.slot": ["text", "secondaryText", "accent"],
};

const legacyFieldForStyle = (kind: string, styleKey: keyof OverlayStyle): string | undefined =>
  legacyColorFields[kind]?.find(([, key]) => key === styleKey)?.[0];

const legacyStyleColor = (kind: string, config: Readonly<Record<string, unknown>>, styleKey: keyof OverlayStyle): string | undefined => {
  const field = legacyFieldForStyle(kind, styleKey);
  const value = field === undefined ? undefined : config[field];
  return typeof value === "string" ? value : undefined;
};

const styleBackgroundColor = (style: OverlayStyle | undefined): string | undefined => {
  const background = style?.background;
  if (background === undefined) return undefined;
  if (background.opacityPercent === 0) return "transparent";
  if (background.opacityPercent === 100) return background.color;
  const opacity = String(background.opacityPercent / 100);
  const red = Number.parseInt(background.color.slice(1, 3), 16);
  const green = Number.parseInt(background.color.slice(3, 5), 16);
  const blue = Number.parseInt(background.color.slice(5, 7), 16);
  return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${opacity})`;
};

export interface EffectiveOverlayElementColors {
  background: string;
  text: string;
  secondaryText?: string;
  accent?: string;
}

export const resolveOverlayElementColors = (
  kind: string,
  config: Readonly<Record<string, unknown>>,
  elementStyle: OverlayStyle,
  overlayStyle: OverlayStyle,
): EffectiveOverlayElementColors => {
  const defaults = defaultElementColors[kind] ?? {};
  const background = styleBackgroundColor(elementStyle) ?? styleBackgroundColor(overlayStyle) ??
    legacyStyleColor(kind, config, "background") ?? defaults.background ?? "transparent";
  const colorFrom = (style: OverlayStyle, key: "color" | "secondaryTextColor" | "accentColor"): string | undefined => {
    if (key === "color") return style.color;
    if (key === "secondaryTextColor") return style.secondaryTextColor;
    return style.accentColor;
  };
  const resolve = (part: "text" | "secondaryText" | "accent"): string | undefined => {
    const key: "color" | "secondaryTextColor" | "accentColor" = part === "text" ? "color" : part === "secondaryText" ? "secondaryTextColor" : "accentColor";
    return colorFrom(elementStyle, key) ?? colorFrom(overlayStyle, key) ??
      legacyStyleColor(kind, config, key) ?? defaults[part];
  };
  const text = resolve("text") ?? "#ffffff";
  const secondaryText = resolve("secondaryText");
  const accent = resolve("accent");
  return { background, text, ...(secondaryText === undefined ? {} : { secondaryText }), ...(accent === undefined ? {} : { accent }) };
};

/** Returns the foreground colors used for text, including accent-colored slot jackpot text. */
export const overlayElementTextColors = (
  kind: string,
  config: Readonly<Record<string, unknown>>,
  elementStyle: OverlayStyle,
  overlayStyle: OverlayStyle,
): readonly string[] => {
  const colors = resolveOverlayElementColors(kind, config, elementStyle, overlayStyle);
  const textColors = (contrastTextParts[kind] ?? ["text"]).flatMap((part) => {
    const foreground = part === "text" ? colors.text : part === "secondaryText" ? colors.secondaryText : colors.accent;
    if (foreground === undefined) return [];
    return [foreground];
  });
  if (kind === "quiz.session") {
    const correctColor = config.correctColor;
    const fallbackCorrectColor = defaultElementColors[kind]?.correctText;
    const validCorrectColor = typeof correctColor === "string" && hexColorPattern.test(correctColor.toLowerCase())
      ? correctColor.toLowerCase()
      : fallbackCorrectColor;
    return validCorrectColor === undefined ? textColors : [...textColors, validCorrectColor];
  }
  if (kind !== "song_requests.now_playing") return textColors;
  const secondaryStyleColor = elementStyle.secondaryTextColor ?? overlayStyle.secondaryTextColor ??
    legacyStyleColor(kind, config, "secondaryTextColor");
  const tertiaryText = defaultElementColors[kind]?.tertiaryText;
  return secondaryStyleColor === undefined && tertiaryText !== undefined ? [...textColors, tertiaryText] : textColors;
};

/** Moves saved module colors into the shared style document while preserving unrelated config. */
export const migrateLegacyOverlayStyles = <Element extends LegacyOverlayElementConfig>(
  elements: readonly Element[],
  styles: OverlayStyleDocument,
): { elements: (Omit<Element, "config"> & { config: Record<string, unknown> })[]; styles: OverlayStyleDocument } => {
  const migratedStyles: Record<string, OverlayStyle> = { ...styles.elements };
  const migratedElements = elements.map((element) => {
    const fields = legacyColorFields[element.kind] ?? [];
    if (fields.length === 0) return { ...element, config: { ...element.config } };
    const config: Record<string, unknown> = { ...element.config };
    const style: OverlayStyle = { ...(migratedStyles[element.id] ?? {}) };
    let changed = false;
    for (const [legacyKey, styleKey] of fields) {
      if (!Object.hasOwn(config, legacyKey)) continue;
      const value = config[legacyKey];
      if (value !== null && (typeof value !== "string" || !hexColorPattern.test(value.toLowerCase()))) continue;
      changed = true;
      Reflect.deleteProperty(config, legacyKey);
      if (style[styleKey] !== undefined || styles.overlay[styleKey] !== undefined) continue;
      const defaultPart = styleKey === "color" ? "text" : styleKey === "secondaryTextColor" ? "secondaryText" : styleKey === "accentColor" ? "accent" : "background";
      const color = value === null ? defaultElementColors[element.kind]?.[defaultPart] : value.toLowerCase();
      if (color === undefined || !hexColorPattern.test(color.toLowerCase())) continue;
      if (styleKey === "background") style.background = { color: color.toLowerCase(), opacityPercent: 100 };
      else if (styleKey === "color") style.color = color.toLowerCase();
      else if (styleKey === "secondaryTextColor") style.secondaryTextColor = color.toLowerCase();
      else if (styleKey === "accentColor") style.accentColor = color.toLowerCase();
    }
    if (!changed) return { ...element, config };
    if (Object.keys(style).length > 0) migratedStyles[element.id] = style;
    return { ...element, config };
  });
  return { elements: migratedElements, styles: { overlay: styles.overlay, elements: migratedStyles } };
};
