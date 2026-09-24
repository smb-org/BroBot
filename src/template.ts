import type { TemplateContext, TemplateVariableGroup, TemplateVariableSource } from "./contracts/values";

export type { TemplateContext, TemplateVariableSource } from "./contracts/values";

export interface TemplateVariable {
  readonly name: string;
  readonly group?: TemplateVariableGroup;
  readonly maxLength: number;
  readonly fallbackWhenAbsent?: number;
  readonly parameters?: "range" | "choices";
  readonly sample: string;
  readonly source?: TemplateVariableSource;
  readonly contexts?: readonly TemplateContext[];
  readonly external?: boolean;
}

export type TemplateFields<Settings> = Readonly<Partial<Record<keyof Settings & string, readonly TemplateVariable[]>>>;

export type TemplateValues<Variables extends readonly TemplateVariable[]> = Readonly<
  Record<Variables[number]["name"], string | number>
>;

export type TemplateWarning =
  | { field: string; code: "unknown_template_variables"; unknownVariables: readonly string[] }
  | { field: string; code: "template_parameters_invalid"; invalidVariables: readonly string[] }
  | { field: string; code: "template_worst_case_too_long"; worstCaseLength: number };

export const TEMPLATE_VARIABLE_PATTERN = /\{([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)(?: ([^{}\n]{1,200}))?\}/g;
export const TEMPLATE_TOKEN_CANDIDATE_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?)(?: ([^{}\n]{1,200}))?\}/g;

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
  [...new Set(matches(text, TEMPLATE_VARIABLE_PATTERN).flatMap((match) => match[1] === undefined ? [] : [match[1]]))];

const folded = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase();

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      const substitution = diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      previous[rightIndex] = Math.min(above + 1, (previous[rightIndex - 1] ?? 0) + 1, substitution);
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
};

export const closestTemplateVariable = (
  name: string,
  declared: readonly TemplateVariable[],
): string | null => {
  const candidate = folded(name);
  let closest: string | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const variable of declared) {
    const comparableName = variable.name.startsWith("var.") ? variable.name.slice(4) : variable.name;
    const distance = editDistance(candidate, folded(comparableName));
    if (distance <= 2 && distance < name.length / 2 && distance < closestDistance) {
      closest = variable.name;
      closestDistance = distance;
    }
  }
  return closest;
};

const parameterIsValid = (variable: TemplateVariable, parameter: string | undefined): boolean => {
  if (parameter === undefined) return true;
  if (variable.parameters === "range") return parseTemplateRange(parameter) !== null;
  if (variable.parameters === "choices") {
    const options = parameter.split("|");
    return options.length >= 2 && options.length <= 20 && options.every((option) => option.trim().length > 0);
  }
  return false;
};

export const parseTemplateRange = (parameter: string): { min: number; max: number } | null => {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(parameter);
  if (match === null) return null;
  const first = Number(match[1]);
  const second = match[2] === undefined ? first : Number(match[2]);
  const min = match[2] === undefined ? 1 : first;
  const max = second;
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 0 && max <= 1_000_000 && min <= max
    ? { min, max }
    : null;
};

export const effectiveTemplateVariables = (
  context: TemplateContext,
  moduleVariables: readonly TemplateVariable[] = [],
  channelVariables: readonly TemplateVariable[] = [],
  systemVariables: readonly TemplateVariable[] = [],
): TemplateVariable[] => {
  const eligibleSystem = systemVariables.filter((variable) => variable.contexts?.includes(context) ?? true);
  const moduleNames = new Set(moduleVariables.map((variable) => variable.name));
  const systemWithoutShadows = eligibleSystem.filter((variable) => !moduleNames.has(variable.name));
  return [
    ...systemWithoutShadows.map((variable) => ({ ...variable, source: "system" as const })),
    ...moduleVariables.map((variable) => ({ ...variable, source: "module" as const })),
    ...channelVariables.map((variable) => ({ ...variable, source: "channel" as const })),
  ];
};

export const unknownTemplateVariables = (
  text: string,
  declared: readonly TemplateVariable[],
): string[] => {
  const variables = new Map(declared.map((variable) => [variable.name, variable]));
  return [...new Set(matches(text, TEMPLATE_TOKEN_CANDIDATE_PATTERN).flatMap((match) => {
    const name = match[1];
    if (name === undefined) return [];
    return variables.has(name) ? [] : [name];
  }))];
};

export const invalidTemplateParameters = (
  text: string,
  declared: readonly TemplateVariable[],
): string[] => {
  const variables = new Map(declared.map((variable) => [variable.name, variable]));
  return [...new Set(matches(text, TEMPLATE_TOKEN_CANDIDATE_PATTERN).flatMap((match) => {
    const name = match[1];
    if (name === undefined) return [];
    const variable = variables.get(name);
    return variable !== undefined && variable.parameters !== undefined && !parameterIsValid(variable, match[2])
      ? [match[0]]
      : [];
  }))];
};

export type TemplateToken = {
  kind: "text" | "system" | "module" | "channel" | "unknown" | "invalid";
  text: string;
  start: number;
  name?: string;
  parameter?: string;
};

export const tokenizeTemplate = (
  text: string,
  declared: readonly TemplateVariable[],
): readonly TemplateToken[] => {
  const variables = new Map(declared.map((variable) => [variable.name, variable]));
  const tokens = matches(text, TEMPLATE_TOKEN_CANDIDATE_PATTERN);
  const pieces: TemplateToken[] = [];
  let offset = 0;
  for (const token of tokens) {
    if (token.index > offset) pieces.push({ kind: "text", text: text.slice(offset, token.index), start: offset });
    const name = token[1];
    const parameter = token[2];
    const variable = name === undefined ? undefined : variables.get(name);
    const kind = variable === undefined
      ? "unknown"
      : parameter !== undefined && variable.parameters === undefined
        ? "text"
        : !parameterIsValid(variable, parameter)
          ? "invalid"
          : variable.source === "system"
            ? "system"
            : variable.source === "channel"
              ? "channel"
              : "module";
    pieces.push({
      kind,
      text: token[0],
      start: token.index,
      ...(name === undefined ? {} : { name }),
      ...(parameter === undefined ? {} : { parameter }),
    });
    offset = token.index + token[0].length;
  }
  if (offset < text.length || pieces.length === 0) pieces.push({ kind: "text", text: text.slice(offset), start: offset });
  return pieces;
};

export const renderTemplate = (
  text: string,
  values: Readonly<Record<string, string | number>>,
  parameterValues: Readonly<Record<string, (parameter: string) => string>> = {},
  declared: readonly TemplateVariable[] = [],
): string => {
  const declarations = new Map(declared.map((variable) => [variable.name, variable]));
  return text.replace(TEMPLATE_VARIABLE_PATTERN, (token, name: string, parameter: string | undefined) => {
    const variable = declarations.get(name);
    if (parameter !== undefined || (name === "random" && variable?.parameters === "range")) {
      const resolver = parameterValues[name];
      const resolvedParameter = parameter ?? "";
      if (variable === undefined || (parameter !== undefined && !parameterIsValid(variable, resolvedParameter)) || resolver === undefined) return token;
      return resolver(resolvedParameter);
    }
    return Object.hasOwn(values, name) ? String(values[name]) : token;
  });
};

const maximumRangeDigits = (parameter: string): number => {
  const range = parseTemplateRange(parameter);
  return range === null ? 0 : String(range.max).length;
};

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
    const replacementLength = token[2] === undefined
      ? variable.maxLength
      : variable.parameters === "range"
        ? maximumRangeDigits(token[2])
        : variable.parameters === "choices"
          ? Math.max(0, ...token[2].split("|").map((choice) => choice.length))
          : token[0].length;
    length += replacementLength - token[0].length;
  }
  for (const variable of declared) if (!present.has(variable.name)) length += variable.fallbackWhenAbsent ?? 0;
  return length;
};

export const templateWarnings = (
  field: string,
  text: string,
  declared: readonly TemplateVariable[],
): TemplateWarning[] => {
  const warnings: TemplateWarning[] = [];
  const unknownVariables = unknownTemplateVariables(text, declared);
  if (unknownVariables.length > 0) warnings.push({ field, code: "unknown_template_variables", unknownVariables });
  const invalidVariables = invalidTemplateParameters(text, declared);
  if (invalidVariables.length > 0) warnings.push({ field, code: "template_parameters_invalid", invalidVariables });
  const worstCaseLength = worstCaseTemplateLength(text, declared);
  if (worstCaseLength > 500) warnings.push({ field, code: "template_worst_case_too_long", worstCaseLength });
  return warnings;
};

export const templateFieldsWarnings = (
  settings: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, readonly TemplateVariable[]>>,
): TemplateWarning[] => Object.entries(fields).flatMap(([field, variables]) => {
  const value = settings[field];
  return typeof value === "string" ? templateWarnings(field, value, variables) : [];
});
