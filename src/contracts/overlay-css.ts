interface CssResource {
  start: number;
  end: number;
  kind: "import" | "url";
  target: string | null;
  valid: boolean;
}

interface CssEscape {
  value: string;
  end: number;
}

const cssEscapeAt = (css: string, start: number): CssEscape => {
  let cursor = start + 1;
  if (cursor >= css.length) return { value: "\\", end: cursor };
  const hexStart = cursor;
  while (cursor < css.length && cursor - hexStart < 6 && /[\da-f]/iu.test(css[cursor] ?? "")) cursor++;
  if (cursor > hexStart) {
    const codePoint = Number.parseInt(css.slice(hexStart, cursor), 16);
    if (/\s/u.test(css[cursor] ?? "")) cursor++;
    return {
      value: codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? "\uFFFD"
        : String.fromCodePoint(codePoint),
      end: cursor,
    };
  }
  const escaped = css[cursor] ?? "";
  return { value: escaped === "\n" || escaped === "\r" ? "" : escaped, end: cursor + 1 };
};

const normalizeCss = (css: string): string => {
  let normalized = "";
  for (let cursor = 0; cursor < css.length;) {
    const character = css[cursor] ?? "";
    if (character === "\"" || character === "'") {
      const quote = character;
      normalized += character;
      cursor++;
      while (cursor < css.length) {
        const next = css[cursor] ?? "";
        if (next === "\\") {
          const escape = cssEscapeAt(css, cursor);
          normalized += css.slice(cursor, escape.end);
          cursor = escape.end;
        } else {
          normalized += next;
          cursor++;
          if (next === quote) break;
        }
      }
    } else if (character === "/" && css[cursor + 1] === "*") {
      const commentEnd = css.indexOf("*/", cursor + 2);
      cursor = commentEnd < 0 ? css.length : commentEnd + 2;
    } else if (character === "\\") {
      const escape = cssEscapeAt(css, cursor);
      normalized += escape.value;
      cursor = escape.end;
    } else {
      normalized += character;
      cursor++;
    }
  }
  return normalized;
};

const isIdentifierCharacter = (character: string): boolean => /[\da-z_-]/iu.test(character);

const readIdentifier = (css: string, start: number): { value: string; end: number } => {
  let cursor = start;
  let value = "";
  while (cursor < css.length) {
    const character = css[cursor] ?? "";
    if (isIdentifierCharacter(character)) {
      value += character;
      cursor++;
    } else if (character === "\\") {
      const escape = cssEscapeAt(css, cursor);
      value += escape.value;
      cursor = escape.end;
    } else {
      break;
    }
  }
  return { value, end: cursor };
};

const readString = (css: string, start: number): { value: string; end: number; closed: boolean } => {
  const quote = css[start] ?? "";
  let value = "";
  let cursor = start + 1;
  while (cursor < css.length) {
    const character = css[cursor] ?? "";
    if (character === "\\") {
      const escape = cssEscapeAt(css, cursor);
      value += escape.value;
      cursor = escape.end;
    } else if (character === quote) {
      return { value, end: cursor + 1, closed: true };
    } else {
      value += character;
      cursor++;
    }
  }
  return { value, end: cursor, closed: false };
};

const skipWhitespace = (css: string, start: number): number => {
  let cursor = start;
  while (cursor < css.length && /\s/u.test(css[cursor] ?? "")) cursor++;
  return cursor;
};

const atRuleEnd = (css: string, start: number): number => {
  let cursor = start;
  let parentheses = 0;
  while (cursor < css.length) {
    const character = css[cursor] ?? "";
    if (character === "\"" || character === "'") {
      cursor = readString(css, cursor).end;
      continue;
    }
    if (character === "(") parentheses++;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === ";" && parentheses === 0) return cursor + 1;
    else if (character === "}" && parentheses === 0) return cursor;
    cursor++;
  }
  return cursor;
};

const readUrlFunction = (css: string, start: number, open: number): CssResource => {
  const contentStart = skipWhitespace(css, open + 1);
  const first = css[contentStart] ?? "";
  if (first === "\"" || first === "'") {
    const string = readString(css, contentStart);
    const close = skipWhitespace(css, string.end);
    const closedFunction = css[close] === ")";
    return {
      start,
      end: closedFunction ? close + 1 : css.length,
      kind: "url",
      target: string.value.trim(),
      valid: string.closed && closedFunction,
    };
  }

  let cursor = contentStart;
  let nested = 0;
  while (cursor < css.length) {
    const character = css[cursor] ?? "";
    if (character === "\\") cursor = cssEscapeAt(css, cursor).end;
    else if (character === "(") { nested++; cursor++; }
    else if (character === ")" && nested > 0) { nested--; cursor++; }
    else if (character === ")") {
      return { start, end: cursor + 1, kind: "url", target: css.slice(contentStart, cursor).trim(), valid: true };
    } else cursor++;
  }
  return { start, end: css.length, kind: "url", target: css.slice(contentStart).trim(), valid: false };
};

const resourcesIn = (css: string): CssResource[] => {
  const resources: CssResource[] = [];
  for (let cursor = 0; cursor < css.length;) {
    const character = css[cursor] ?? "";
    if (character === "\"" || character === "'") {
      cursor = readString(css, cursor).end;
      continue;
    }
    if (character === "@") {
      const identifier = readIdentifier(css, cursor + 1);
      if (identifier.value.toLowerCase() === "import") {
        const end = atRuleEnd(css, identifier.end);
        resources.push({ start: cursor, end, kind: "import", target: null, valid: false });
        cursor = Math.max(end, cursor + 1);
        continue;
      }
      cursor = Math.max(identifier.end, cursor + 1);
      continue;
    }
    if (/[a-z_-]/iu.test(character)) {
      const identifier = readIdentifier(css, cursor);
      const open = skipWhitespace(css, identifier.end);
      if (identifier.value.toLowerCase() === "url" && css[open] === "(") {
        const resource = readUrlFunction(css, cursor, open);
        resources.push(resource);
        cursor = Math.max(resource.end, cursor + 1);
      } else {
        cursor = Math.max(identifier.end, cursor + 1);
      }
      continue;
    }
    cursor++;
  }
  return resources;
};

const isRelativeAssetTarget = (target: string): boolean => target.length > 0 &&
  !target.startsWith("/") &&
  !/^[a-z][a-z\d+.-]*:/iu.test(target) &&
  !/[\\\s"'(){}]/u.test(target);

/** Custom overlay CSS can reference same-origin relative assets but cannot import stylesheets or fetch remote URLs. */
export const isOverlayCssSafe = (css: string): boolean => resourcesIn(normalizeCss(css)).every((resource) =>
  resource.kind === "url" && resource.valid && resource.target !== null && isRelativeAssetTarget(resource.target));

/** Defense in depth for older saved CSS and data returned by stale workers. */
export const sanitizeOverlayCss = (css: string): string => {
  const normalized = normalizeCss(css);
  let sanitized = normalized;
  for (const resource of resourcesIn(normalized).reverse()) {
    if (resource.kind === "import") sanitized = `${sanitized.slice(0, resource.start)}${sanitized.slice(resource.end)}`;
    else if (!resource.valid || resource.target === null || !isRelativeAssetTarget(resource.target)) {
      sanitized = `${sanitized.slice(0, resource.start)}none${sanitized.slice(resource.end)}`;
    }
  }
  return sanitized;
};
