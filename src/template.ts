export interface TemplateVariable {
  /** Name in braces, such as `{viewers}`. */
  readonly name: string;
  /** Sample value used by the panel preview. */
  readonly sample: string;
  /** Longest value the worker may substitute. */
  readonly maxLength: number;
  /** Maximum fallback text length when the variable is absent from a template. */
  readonly fallbackWhenAbsent?: number;
}

export type TemplateFields<Settings> = Readonly<Partial<Record<keyof Settings & string, readonly TemplateVariable[]>>>;

export type TemplateValues<Variables extends readonly TemplateVariable[]> = Readonly<
  Record<Variables[number]["name"], string | number>
>;

export type TemplateWarning =
  | { field: string; code: "unknown_template_variables"; unknownVariables: readonly string[] }
  | { field: string; code: "template_worst_case_too_long"; worstCaseLength: number };

export const TEMPLATE_VARIABLE_PATTERN = /\{([a-z][a-z0-9_]*)\}/g;
export const TEMPLATE_TOKEN_CANDIDATE_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

const matches = (text: string, pattern: RegExp): RegExpExecArray[] => {
  const expression = new RegExp(pattern.source, "g");
  const result: RegExpExecArray[] = [];
  let match = expression.exec(text);
  while (match !== null) {
    result.push(match);
    match = expression.exec(text);
  }
  return result;
};

export const templateVariableNames = (text: string): string[] =>
  matches(text, TEMPLATE_VARIABLE_PATTERN).flatMap((match) => match[1] === undefined ? [] : [match[1]]);

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      const substitution = diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      previous[rightIndex] = Math.min(
        above + 1,
        (previous[rightIndex - 1] ?? 0) + 1,
        substitution,
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
};

export const closestTemplateVariable = (
  name: string,
  declared: readonly TemplateVariable[],
): string | null => {
  const candidate = name.toLowerCase();
  let closest: string | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const variable of declared) {
    const distance = editDistance(candidate, variable.name.toLowerCase());
    if (distance <= 2 && distance < name.length / 2 && distance < closestDistance) {
      closest = variable.name;
      closestDistance = distance;
    }
  }
  return closest;
};

export const unknownTemplateVariables = (
  text: string,
  declared: readonly TemplateVariable[],
): string[] => {
  const names = new Set(declared.map((variable) => variable.name));
  return [...new Set(matches(text, TEMPLATE_TOKEN_CANDIDATE_PATTERN)
    .flatMap((match) => match[1] === undefined || names.has(match[1]) ? [] : [match[1]]))];
};

export const tokenizeTemplate = (
  text: string,
  declared: readonly TemplateVariable[],
): readonly { kind: "text" | "known" | "unknown"; text: string; start: number }[] => {
  const names = new Set(declared.map((variable) => variable.name));
  const tokens = matches(text, TEMPLATE_TOKEN_CANDIDATE_PATTERN);
  const pieces: { kind: "text" | "known" | "unknown"; text: string; start: number }[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (token.index > offset) pieces.push({ kind: "text", text: text.slice(offset, token.index), start: offset });
    const end = token.index + token[0].length;
    pieces.push({
      kind: token[1] !== undefined && names.has(token[1]) ? "known" : "unknown",
      text: token[0],
      start: token.index,
    });
    offset = end;
  }
  if (offset < text.length || pieces.length === 0) {
    pieces.push({ kind: "text", text: text.slice(offset), start: offset });
  }
  return pieces;
};

export const renderTemplate = (
  text: string,
  values: Readonly<Record<string, string | number>>,
): string => text.replace(TEMPLATE_VARIABLE_PATTERN, (token, name: string) =>
  Object.hasOwn(values, name) ? String(values[name]) : token);

export const worstCaseTemplateLength = (
  text: string,
  declared: readonly TemplateVariable[],
): number => {
  const variables = new Map(declared.map((variable) => [variable.name, variable]));
  const present = new Set<string>();
  let length = text.length;
  for (const token of matches(text, TEMPLATE_VARIABLE_PATTERN)) {
    const name = token[1];
    if (name === undefined) continue;
    const variable = variables.get(name);
    if (variable === undefined) continue;
    present.add(name);
    length += variable.maxLength - token[0].length;
  }
  for (const variable of declared) {
    if (!present.has(variable.name)) length += variable.fallbackWhenAbsent ?? 0;
  }
  return length;
};

export const templateWarnings = (
  field: string,
  text: string,
  declared: readonly TemplateVariable[],
): TemplateWarning[] => {
  const warnings: TemplateWarning[] = [];
  const unknownVariables = unknownTemplateVariables(text, declared);
  if (unknownVariables.length > 0) {
    warnings.push({ field, code: "unknown_template_variables", unknownVariables });
  }
  const worstCaseLength = worstCaseTemplateLength(text, declared);
  if (worstCaseLength > 500) {
    warnings.push({ field, code: "template_worst_case_too_long", worstCaseLength });
  }
  return warnings;
};

export const templateFieldsWarnings = (
  settings: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, readonly TemplateVariable[]>>,
): TemplateWarning[] => Object.entries(fields).flatMap(([field, variables]) => {
  const value = settings[field];
  return typeof value === "string" ? templateWarnings(field, value, variables) : [];
});
