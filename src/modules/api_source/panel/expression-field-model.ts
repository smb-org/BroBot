import type { ModuleLanguage } from "../../contract";
import type { ApiSourceFunction, ApiSourceFunctionGroup } from "../contracts/function-catalog";
import type { InlineSuggestionGroup, InlineSuggestionGroupPresentation } from "../../../dashboard/ui";

export interface ExpressionFunctionQuery {
  fragment: string;
  start: number;
  end: number;
}

export interface LocalizedApiSourceFunction extends ApiSourceFunction {
  localizedDescription: string;
}

const functionGroupOrder: readonly ApiSourceFunctionGroup[] = ["text", "number", "logic", "list", "date"];

const functionGroupIcons = {
  text: "styleFont",
  number: "tabAdvanced",
  logic: "tabSettings",
  list: "tabCode",
  date: "clock-hour-4",
} as const satisfies Record<ApiSourceFunctionGroup, NonNullable<InlineSuggestionGroupPresentation["iconName"]>>;

const normalizeSearch = (value: string): string => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/gu, "")
  .toLowerCase();

const skipExpressionTrivia = (value: string, start: number): number => {
  let index = start;
  while (index < value.length) {
    const character = value[index];
    if (character !== undefined && /[ \t\n\r\v]/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      const commentEnd = value.indexOf("*/", index + 2);
      if (commentEnd < 0) return value.length;
      index = commentEnd + 2;
      continue;
    }
    break;
  }
  return index;
};

export const expressionHasCallOpeningParenthesis = (value: string, start: number): boolean =>
  value[skipExpressionTrivia(value, start)] === "(";

const isInsideProtectedExpressionRegion = (value: string, end: number): boolean => {
  let quote: "'" | '"' | null = null;
  let backtick = false;
  let comment = false;
  let escaped = false;
  for (let index = 0; index < end; index += 1) {
    const character = value[index];
    if (character === undefined) continue;
    if (comment) {
      if (character === "*" && value[index + 1] === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (backtick) {
      if (character === "`") backtick = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      comment = true;
      index += 1;
      continue;
    }
    if (character === "`") {
      backtick = true;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
  }
  return quote !== null || backtick || comment;
};

export const expressionFunctionQueryAtCaret = (value: string, caret: number): ExpressionFunctionQuery | null => {
  if (isInsideProtectedExpressionRegion(value, caret)) return null;
  const prefix = value.slice(0, caret);
  const match = /\$([\p{L}\p{N}_]*)$/u.exec(prefix);
  if (match === null || value[caret] === ".") return null;
  const suffix = /^[\p{L}\p{N}_]*/u.exec(value.slice(caret))?.[0] ?? "";
  return { fragment: match[1] ?? "", start: match.index, end: caret + suffix.length };
};

export const apiSourceFunctionAtCaret = (
  value: string,
  caret: number,
  functions: readonly ApiSourceFunction[],
): ApiSourceFunction | null => {
  const byName = new Map(functions.map((entry) => [entry.name, entry]));
  const calls: (ApiSourceFunction | null)[] = [];
  let quote: "'" | '"' | null = null;
  let backtick = false;
  let comment = false;
  let escaped = false;

  for (let index = 0; index < caret; index += 1) {
    const character = value[index];
    if (character === undefined) continue;
    if (comment) {
      if (character === "*" && value[index + 1] === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (backtick) {
      if (character === "`") backtick = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      comment = true;
      index += 1;
      continue;
    }
    if (character === "`") {
      backtick = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$") {
      const match = /^\$([A-Za-z][A-Za-z0-9_]*)/u.exec(value.slice(index));
      const entry = match === null ? undefined : byName.get(match[1] ?? "");
      if (match !== null) {
        const openParenthesis = skipExpressionTrivia(value, index + match[0].length);
        if (value[openParenthesis] === "(" && openParenthesis < caret) {
          calls.push(entry ?? null);
          index = openParenthesis;
        }
      }
    } else if (character === "(") {
      calls.push(null);
    } else if (character === ")") {
      calls.pop();
    }
  }

  return calls.at(-1) ?? null;
};

export const groupApiSourceFunctions = (
  functions: readonly ApiSourceFunction[],
  language: ModuleLanguage,
  groupLabels: Readonly<Record<ApiSourceFunctionGroup, string>>,
  query: string,
): InlineSuggestionGroup<LocalizedApiSourceFunction>[] => {
  const normalizedQuery = normalizeSearch(query.trim());
  const seen = new Set<string>();
  const localized = functions.flatMap((entry, originalIndex) => {
    if (seen.has(entry.name)) return [];
    seen.add(entry.name);
    const option: LocalizedApiSourceFunction = { ...entry, localizedDescription: entry.description[language] };
    const name = normalizeSearch(entry.name);
    const signature = normalizeSearch(entry.signature);
    const description = normalizeSearch(option.localizedDescription);
    const groupLabel = normalizeSearch(groupLabels[entry.group]);
    const rank = normalizedQuery.length === 0 ? 0
      : name === normalizedQuery ? 0
        : name.startsWith(normalizedQuery) ? 1
          : name.includes(normalizedQuery) ? 2
            : signature.startsWith(normalizedQuery) ? 3
              : signature.includes(normalizedQuery) ? 4
                : description.includes(normalizedQuery) ? 5
                  : groupLabel.includes(normalizedQuery) ? 6 : -1;
    return rank < 0 ? [] : [{ option, rank, originalIndex }];
  });

  let index = 0;
  const groups = functionGroupOrder.map((group) => ({
    group,
    entries: localized.filter(({ option }) => option.group === group)
      .sort((left, right) => left.rank - right.rank || left.originalIndex - right.originalIndex),
  })).filter(({ entries }) => entries.length > 0);
  if (normalizedQuery.length > 0) {
    groups.sort((left, right) => (left.entries[0]?.rank ?? 0) - (right.entries[0]?.rank ?? 0) ||
      functionGroupOrder.indexOf(left.group) - functionGroupOrder.indexOf(right.group));
  }
  return groups.map(({ group, entries }) => {
    const options = entries.map(({ option }) => ({ option, index: index++ }));
    const presentation: InlineSuggestionGroupPresentation = {
      id: group,
      label: groupLabels[group],
      iconName: functionGroupIcons[group],
      order: functionGroupOrder.indexOf(group),
    };
    return { group: presentation, options };
  });
};
