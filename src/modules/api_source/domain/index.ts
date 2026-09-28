import jsonata from "jsonata";

import { API_SOURCE_MAXIMUMS } from "../contracts";

export const JSONATA_LIMITS = {
  stackDepth: 64,
  maximumSequenceLength: 1_000,
  maximumInputDepth: 64,
  maximumInputNodes: 20_000,
  maximumInputBytes: 64 * 1024,
  maximumReplaceLimit: 10,
} as const;

type JsonataNode = {
  type?: string;
  value?: unknown;
  procedure?: unknown;
  arguments?: unknown;
  steps?: unknown;
  [key: string]: unknown;
};

export type ApiSourceExpressionValidationError =
  | { kind: "too_long" }
  | { kind: "syntax" }
  | { kind: "function_not_allowed"; functionName: string };

const allowedFunctions = new Set([
  "string", "number", "boolean", "not", "exists", "length", "substring", "substringBefore",
  "substringAfter", "uppercase", "lowercase", "trim", "contains", "join", "sum", "max", "min",
  "average", "count", "round", "floor", "ceil", "abs", "formatNumber", "keys", "lookup",
  "fromMillis", "toMillis", "now", "split", "replace",
]);

const validatedInputs = new WeakSet<object>();

const assertJsonDepth = (value: unknown): void => {
  if (typeof value === "object" && value !== null && validatedInputs.has(value)) return;
  const serialized: unknown = JSON.stringify(value);
  if (typeof serialized === "string" && new TextEncoder().encode(serialized).byteLength > JSONATA_LIMITS.maximumInputBytes) {
    throw new Error("API source JSON exceeded the evaluation limits.");
  }
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > JSONATA_LIMITS.maximumInputNodes || current.depth > JSONATA_LIMITS.maximumInputDepth) {
      throw new Error("API source JSON exceeded the evaluation limits.");
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) pending.push({ value: entry, depth: current.depth + 1 });
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const entry of Object.values(current.value)) pending.push({ value: entry, depth: current.depth + 1 });
    }
  }
  if (typeof value === "object" && value !== null) validatedInputs.add(value);
};

const isNode = (value: unknown): value is JsonataNode => typeof value === "object" && value !== null && !Array.isArray(value);

const functionNameOf = (procedure: unknown): string => {
  if (isNode(procedure) && procedure.type === "variable" && typeof procedure.value === "string") {
    return `$${procedure.value}`;
  }
  if (isNode(procedure) && procedure.type === "path" && Array.isArray(procedure.steps)) {
    const names = procedure.steps
      .filter(isNode)
      .map((step) => step.value)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return `$${names.join(".") || "<dynamic>"}`;
  }
  return "$<dynamic>";
};

const containsRegexNode = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsRegexNode);
  if (!isNode(value)) return false;
  if (value.type === "regex") return true;
  return Object.values(value).some(containsRegexNode);
};

const findDisallowedFunction = (value: unknown, seen = new WeakSet<object>()): string | null => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const disallowed = findDisallowedFunction(entry, seen);
      if (disallowed !== null) return disallowed;
    }
    return null;
  }
  if (!isNode(value) || seen.has(value)) return null;
  seen.add(value);

  if (value.type === "regex") return "$regex";
  if (value.type === "lambda") return "$function";
  if (value.type === "partial" || value.type === "transform") return "$function";
  if (value.type === "bind") {
    const rhs = value.rhs;
    if (isNode(rhs) && rhs.type === "variable" && typeof rhs.value === "string") return `$${rhs.value}`;
    return "$function";
  }
  if (value.type === "variable" && typeof value.value === "string" && value.value.length > 0) return `$${value.value}`;
  if (value.type === "function") {
    const functionName = functionNameOf(value.procedure);
    const bareName = functionName.startsWith("$") ? functionName.slice(1) : functionName;
    if (!allowedFunctions.has(bareName)) return functionName;
    const args: unknown[] = Array.isArray(value.arguments) ? value.arguments as unknown[] : [];
    if (bareName === "contains" || bareName === "split" || bareName === "replace") {
      if (args.some(containsRegexNode)) return functionName;
    }
    if (bareName === "replace") {
      const limit = args[3];
      if (args.length !== 4 || !isNode(limit) || limit.type !== "number" ||
          typeof limit.value !== "number" || !Number.isInteger(limit.value) ||
          limit.value < 0 || limit.value > JSONATA_LIMITS.maximumReplaceLimit) {
        return functionName;
      }
    }
    for (const argument of args) {
      const disallowed = findDisallowedFunction(argument, seen);
      if (disallowed !== null) return disallowed;
    }
    return null;
  }

  for (const child of Object.values(value)) {
    const disallowed = findDisallowedFunction(child, seen);
    if (disallowed !== null) return disallowed;
  }
  return null;
};

export const inspectApiSourceExpression = (expression: string): ApiSourceExpressionValidationError | null => {
  if (expression.length > API_SOURCE_MAXIMUMS.expressionLength) return { kind: "too_long" };
  if (expression.trim().length === 0) return null;
  try {
    const compiled = jsonata(expression, {
      stack: JSONATA_LIMITS.stackDepth,
      sequence: JSONATA_LIMITS.maximumSequenceLength,
    });
    const disallowedFunction = findDisallowedFunction(compiled.ast());
    return disallowedFunction === null ? null : { kind: "function_not_allowed", functionName: disallowedFunction };
  } catch {
    return { kind: "syntax" };
  }
};

export const validateJsonataExpression = (expression: string): boolean => inspectApiSourceExpression(expression) === null;

const cappedAppend = (current: string, next: string): string => {
  const remaining = API_SOURCE_MAXIMUMS.outputLength - current.length;
  return remaining <= 0 ? current : current + next.slice(0, remaining);
};

const safeJoin = (values: unknown, separator: unknown = ""): string | undefined => {
  if (values === undefined) return undefined;
  const items = Array.isArray(values) ? values : [values];
  if (separator !== undefined && typeof separator !== "string") {
    throw new Error("API source $join requires a string separator.");
  }
  const delimiter = typeof separator === "string" ? separator : "";
  let result = "";
  for (const [index, value] of items.entries()) {
    if (index > 0) result = cappedAppend(result, delimiter);
    let item: string;
    if (value === undefined || value === null) item = "";
    else if (typeof value === "string") item = value;
    else if (typeof value === "number" || typeof value === "boolean") item = String(value);
    else throw new Error("API source $join requires scalar values.");
    result = cappedAppend(result, item);
    if (result.length >= API_SOURCE_MAXIMUMS.outputLength) break;
  }
  return result;
};

const safeSplit = (input: unknown, separator: unknown, limit: unknown = JSONATA_LIMITS.maximumSequenceLength): string[] | undefined => {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || typeof separator !== "string" ||
      typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 ||
      limit > JSONATA_LIMITS.maximumSequenceLength) {
    throw new Error("API source $split requires a string separator and a bounded integer limit.");
  }
  return input.split(separator, limit);
};

const safeReplace = (input: unknown, pattern: unknown, replacement: unknown, limit: unknown): string | undefined => {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || typeof pattern !== "string" || typeof replacement !== "string" ||
      typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 ||
      limit > JSONATA_LIMITS.maximumReplaceLimit || pattern.length === 0) {
    throw new Error("API source $replace requires strings and a bounded integer limit.");
  }
  let result = "";
  let position = 0;
  let count = 0;
  while (count < limit) {
    const match = input.indexOf(pattern, position);
    if (match < 0) break;
    result = cappedAppend(result, input.slice(position, match));
    result = cappedAppend(result, replacement);
    position = match + pattern.length;
    count += 1;
    if (result.length >= API_SOURCE_MAXIMUMS.outputLength) return result;
  }
  return cappedAppend(result, input.slice(position));
};

export const evaluateApiSourceExpression = async (expression: string, input: unknown): Promise<unknown> => {
  assertJsonDepth(input);
  if (expression.trim().length === 0) return input;
  const validationError = inspectApiSourceExpression(expression);
  if (validationError !== null) {
    if (validationError.kind === "function_not_allowed") {
      throw new Error(`JSONata function ${validationError.functionName} is not allowed.`);
    }
    throw new Error("API source JSONata expression is invalid or exceeds the evaluation limits.");
  }
  const compiled = jsonata(expression, {
    stack: JSONATA_LIMITS.stackDepth,
    sequence: JSONATA_LIMITS.maximumSequenceLength,
  });
  compiled.registerFunction("join", safeJoin);
  compiled.registerFunction("split", safeSplit);
  compiled.registerFunction("replace", safeReplace);
  // The AST allowlist leaves only deterministic JSONata functions; these
  // wrappers also cap output while it is being constructed.
  return await compiled.evaluate(input);
};

export const formatApiSourceValue = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, API_SOURCE_MAXIMUMS.outputLength);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) throw new Error("API source expression returned no value.");
  const serialized: unknown = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("API source expression returned no JSON value.");
  return serialized.slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

export const parseApiSourceName = (conditionId: string): string | null => {
  const match = /^api_source\.([a-z][a-z0-9_]{0,31})$/u.exec(conditionId);
  return match?.[1] ?? null;
};
