import jsonata from "jsonata";

import { API_SOURCE_MAXIMUMS } from "../contracts";

export const JSONATA_LIMITS = {
  stackDepth: 64,
  maximumSequenceLength: 1_000,
  maximumAstNodes: 64,
  maximumAstDepth: 12,
  maximumInputDepth: 64,
  maximumInputNodes: 20_000,
  maximumInputBytes: 64 * 1024,
  maximumReplaceLimit: 10,
  maximumStringWorkLength: 8_192,
  maximumAggregateLength: 1_000,
} as const;

type JsonataNode = {
  type?: unknown;
  value?: unknown;
  [key: string]: unknown;
};

export type ApiSourceExpressionValidationError =
  | { kind: "too_long" }
  | { kind: "syntax" }
  | { kind: "construct_not_allowed"; constructName: string };

const allowedFunctions = new Set([
  "string", "number", "boolean", "not", "exists", "length", "substring", "substringBefore",
  "substringAfter", "uppercase", "lowercase", "trim", "contains", "join", "sum", "max", "min",
  "average", "count", "round", "floor", "ceil", "abs", "formatNumber", "fromMillis", "toMillis",
  "now", "split", "replace",
]);

const arithmeticOperators = new Set(["+", "-", "*", "/", "%"]);
const formatNumberPictures = new Map<string, Intl.NumberFormatOptions>([
  ["#,##0", { useGrouping: true, minimumFractionDigits: 0, maximumFractionDigits: 0 }],
  ["#,##0.00", { useGrouping: true, minimumFractionDigits: 2, maximumFractionDigits: 2 }],
  ["0", { useGrouping: false, minimumFractionDigits: 0, maximumFractionDigits: 0 }],
  ["0.0", { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 }],
  ["0.00", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }],
  ["0%", { style: "percent", useGrouping: false, minimumFractionDigits: 0, maximumFractionDigits: 0 }],
]);
const fromMillisPictures = new Set(["[H01]:[m01]"]);

type AstRole = "expression" | "path_step" | "path_stage" | "array_index" | "function_procedure";

const propertySets: Readonly<Record<string, readonly string[]>> = {
  binary: ["type", "value", "position", "lhs", "rhs"],
  condition: ["type", "position", "condition", "then", "else"],
  filter: ["type", "expr", "position"],
  function: ["type", "name", "value", "position", "arguments", "procedure"],
  name: ["type", "value", "position", "stages"],
  number: ["type", "value", "position"],
  path: ["type", "steps", "group"],
  string: ["type", "value", "position"],
  variable: ["type", "value", "position"],
  value: ["type", "value", "position"],
};

const binaryOperators = new Set([
  "+", "-", "*", "/", "%", "=", "!=", "<", "<=", ">", ">=", "and", "or", "&",
]);

const isNode = (value: unknown): value is JsonataNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAstNode = (value: unknown): value is JsonataNode => isNode(value) && typeof value.type === "string";

const ownKeysAreAllowed = (node: JsonataNode, allowed: readonly string[]): boolean =>
  Object.keys(node).every((key) => allowed.includes(key));

const positionIsValid = (node: JsonataNode): boolean =>
  typeof node.position === "number" && Number.isSafeInteger(node.position) && node.position > 0;

const functionNameOf = (procedure: unknown): string =>
  isAstNode(procedure) && procedure.type === "variable" && typeof procedure.value === "string" && procedure.value.length > 0
    ? `$${procedure.value}`
    : "$<dynamic>";

const disallowedNodeName = (node: JsonataNode): string => {
  switch (node.type) {
    case "apply": return "function chaining (~>)";
    case "bind": return "variable binding (:=)";
    case "block": return "block expression";
    case "descendant": return "descendant lookup (**)";
    case "lambda": return "lambda";
    case "partial": return "partial application";
    case "regex": return "regex literal";
    case "sort": return "sort";
    case "transform": return "transform";
    case "unary": return node.value === "[" ? "array constructor" : node.value === "{" ? "object constructor" : "unary expression";
    case "wildcard": return "wildcard";
    case "function": return functionNameOf(node.procedure);
    case "filter": return "predicate";
    default: return typeof node.type === "string" ? `AST node ${node.type}` : "unknown AST node";
  }
};

const inspectAst = (root: unknown): string | null => {
  let nodeCount = 0;
  let rejected: string | null = null;
  const reject = (constructName: string): void => { rejected ??= constructName; };

  const walkValue = (value: unknown, depth: number, role: AstRole = "expression"): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walkValue(entry, depth, role);
      return;
    }
    if (!isNode(value)) return;
    if (!isAstNode(value)) {
      for (const child of Object.values(value)) walkValue(child, depth, "expression");
      return;
    }

    nodeCount += 1;
    if (nodeCount > JSONATA_LIMITS.maximumAstNodes) {
      reject("AST node limit");
      return;
    }
    if (depth > JSONATA_LIMITS.maximumAstDepth) {
      reject("AST depth limit");
      return;
    }

    const type = value.type as string;
    const allowedProperties = propertySets[type];
    if (allowedProperties === undefined) {
      reject(disallowedNodeName(value));
      for (const child of Object.values(value)) walkValue(child, depth + 1, "expression");
      return;
    }

    if (!ownKeysAreAllowed(value, allowedProperties)) {
      const property = Object.keys(value).find((key) => !allowedProperties.includes(key));
      if (type === "path" && property === "group") reject("group-by");
      else if (type === "variable" && property === "predicate") reject(`${functionNameOf(value)} predicate`);
      else reject(`${type} property ${property ?? "<unknown>"}`);
    }

    switch (type) {
      case "binary":
        if (role !== "expression" || !positionIsValid(value) || !binaryOperators.has(String(value.value))) {
          reject(`operator ${String(value.value)}`);
        }
        break;
      case "condition":
        if (role !== "expression" || !positionIsValid(value)) reject("conditional expression");
        break;
      case "filter":
        if (role !== "path_stage" || !positionIsValid(value)) reject("predicate");
        break;
      case "function": {
        const procedure = value.procedure;
        const functionName = functionNameOf(procedure);
        const functionValue = isAstNode(procedure) && procedure.type === "variable" ? procedure.value : null;
        if (role !== "expression" || value.name !== undefined || value.value !== "(" || !positionIsValid(value)) {
          reject("function call syntax");
        }
        if (typeof functionValue !== "string" || !allowedFunctions.has(functionValue)) reject(functionName);
        if (isAstNode(procedure) && (procedure.type !== "variable" || !ownKeysAreAllowed(procedure, propertySets.variable ?? []))) {
          reject(procedure.type === "variable" ? `${functionName} predicate` : `${functionName} function reference`);
        }
        if (!Array.isArray(value.arguments)) reject(`${functionName} arguments`);
        const args: unknown[] = Array.isArray(value.arguments) ? value.arguments as unknown[] : [];
        const isStringLiteral = (argument: unknown): argument is JsonataNode =>
          isAstNode(argument) && argument.type === "string" && typeof argument.value === "string";
        if (functionValue === "formatNumber") {
          const picture = args[1];
          if ((args.length !== 1 && args.length !== 2) ||
              (args.length === 2 && (!isStringLiteral(picture) || !formatNumberPictures.has(picture.value as string)))) {
            reject("$formatNumber (approved string-literal picture required)");
          }
        }
        if (functionValue === "fromMillis") {
          const picture = args[1];
          if ((args.length !== 1 && args.length !== 2) ||
              (args.length === 2 && (!isStringLiteral(picture) || !fromMillisPictures.has(picture.value as string)))) {
            reject("$fromMillis (approved string-literal picture required)");
          }
        }
        if (functionValue === "toMillis" && args.length !== 1) {
          reject("$toMillis (ISO-8601 timestamps only)");
        }
        if (functionValue === "replace") {
          const pattern = args[1];
          const limit = args[3];
          if (args.length !== 4 || !isAstNode(pattern) || pattern.type !== "string" ||
              !isAstNode(limit) || limit.type !== "number" || typeof limit.value !== "number" ||
              !Number.isSafeInteger(limit.value) || limit.value < 0 || limit.value > JSONATA_LIMITS.maximumReplaceLimit) {
            reject("$replace (string pattern and bounded limit required)");
          }
        }
        break;
      }
      case "name":
        if (role !== "path_step" || typeof value.value !== "string" || value.value.length === 0 || !positionIsValid(value)) {
          reject("path field name");
        }
        if (value.stages !== undefined && !Array.isArray(value.stages)) reject("path stages");
        break;
      case "number":
        if ((role !== "expression" && role !== "array_index") || typeof value.value !== "number" || !Number.isFinite(value.value) ||
            (role === "array_index" && (!Number.isSafeInteger(value.value) || value.value < 0)) || !positionIsValid(value)) {
          reject(role === "array_index" ? "array index predicate (non-negative integer literal required)" : "number literal");
        }
        break;
      case "path":
        if (role !== "expression" || !Array.isArray(value.steps) || value.steps.length === 0) {
          reject("path expression");
        }
        if (Object.hasOwn(value, "group")) reject("group-by");
        break;
      case "string":
        if (role !== "expression" || typeof value.value !== "string" || !positionIsValid(value)) reject("string literal");
        break;
      case "value":
        if (role !== "expression" && role !== "array_index") reject("literal");
        if ((value.value !== null && typeof value.value !== "boolean") || !positionIsValid(value)) {
          reject(role === "array_index" ? "array index predicate (non-negative integer literal required)" : "boolean or null literal");
        } else if (role === "array_index") {
          reject("array index predicate (non-negative integer literal required)");
        }
        break;
      case "variable":
        if (!positionIsValid(value)) reject("variable reference");
        if (role === "function_procedure") {
          if (typeof value.value !== "string" || !allowedFunctions.has(value.value)) reject(functionNameOf(value));
        } else if ((role === "expression" || role === "path_step") && value.value === "") {
          // The empty variable name is JSONata's current-input reference ($).
        } else {
          reject(typeof value.value === "string" && value.value.length > 0 ? `$${value.value}` : "variable reference");
        }
        break;
      default:
        reject(disallowedNodeName(value));
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "type" || key === "position" || key === "name" || key === "value") continue;
      let childRole: AstRole = "expression";
      if (type === "path" && key === "steps") childRole = "path_step";
      else if (type === "name" && key === "stages") childRole = "path_stage";
      else if (type === "filter" && key === "expr") childRole = "array_index";
      else if (type === "function" && key === "procedure") childRole = "function_procedure";
      walkValue(child, depth + 1, childRole);
    }
  };

  walkValue(root, 1);
  return rejected;
};

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

export const inspectApiSourceExpression = (expression: string): ApiSourceExpressionValidationError | null => {
  if (expression.length > API_SOURCE_MAXIMUMS.expressionLength) return { kind: "too_long" };
  if (expression.trim().length === 0) return null;
  try {
    const compiled = jsonata(expression, {
      stack: JSONATA_LIMITS.stackDepth,
      sequence: JSONATA_LIMITS.maximumSequenceLength,
    });
    const disallowedConstruct = inspectAst(compiled.ast());
    return disallowedConstruct === null ? null : { kind: "construct_not_allowed", constructName: disallowedConstruct };
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
  if (items.length > JSONATA_LIMITS.maximumAggregateLength) throw new Error("API source $join exceeded the aggregate limit.");
  const delimiter = requireBoundedString(separator === undefined ? "" : separator, "$join");
  let result = "";
  for (const [index, value] of items.entries()) {
    if (index > 0) result = cappedAppend(result, delimiter);
    let item: string;
    if (value === undefined || value === null) item = "";
    else if (typeof value === "string") item = requireBoundedString(value, "$join");
    else if (typeof value === "number" || typeof value === "boolean") item = boundedString(value);
    else throw new Error("API source $join requires scalar values.");
    result = cappedAppend(result, item);
    if (result.length >= API_SOURCE_MAXIMUMS.outputLength) break;
  }
  return result;
};

const requireBoundedString = (value: unknown, functionName: string): string => {
  if (typeof value !== "string" || value.length > JSONATA_LIMITS.maximumStringWorkLength) {
    throw new Error(`API source ${functionName} requires a bounded string.`);
  }
  return value;
};

const boundedString = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, API_SOURCE_MAXIMUMS.outputLength);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("API source JSONata returned a non-finite number.");
    return String(value);
  }
  if (typeof value === "boolean" || value === null) return String(value);
  if (value === undefined) return "";
  const serialized: unknown = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("API source JSONata returned no JSON string.");
  return serialized.slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

const safeString = (value: unknown): string | undefined => value === undefined ? undefined : boundedString(value);

const safeLength = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  return Array.from(requireBoundedString(value, "$length")).length;
};

const safeContains = (input: unknown, search: unknown): boolean | undefined => {
  if (input === undefined || search === undefined) return undefined;
  return requireBoundedString(input, "$contains").includes(requireBoundedString(search, "$contains"));
};

const safeCase = (input: unknown, upper: boolean): string | undefined => {
  if (input === undefined) return undefined;
  const text = requireBoundedString(input, upper ? "$uppercase" : "$lowercase");
  return (upper ? text.toUpperCase() : text.toLowerCase()).slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

const safeTrim = (input: unknown): string | undefined => {
  if (input === undefined) return undefined;
  return requireBoundedString(input, "$trim").trim().slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

const safeNumber = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "number") return finiteNumber(value, "$number");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") throw new Error("API source $number requires a number, boolean, or string.");
  const text = requireBoundedString(value, "$number").trim();
  if (text.length === 0) return undefined;
  return finiteNumber(Number(text), "$number");
};

const safeRound = (value: unknown, precision: unknown = 0): number | undefined => {
  if (value === undefined) return undefined;
  const number = finiteNumber(value, "$round");
  const digits = precision === undefined ? 0 : precision;
  if (typeof digits !== "number" || !Number.isInteger(digits) || digits < -15 || digits > 15) {
    throw new Error("API source $round requires an integer precision from -15 to 15.");
  }
  const factor = 10 ** digits;
  return finiteNumber(Math.round(number * factor) / factor, "$round");
};

const safeMath = (value: unknown, operation: "floor" | "ceil" | "abs"): number | undefined => {
  if (value === undefined) return undefined;
  const number = finiteNumber(value, `$${operation}`);
  const result = operation === "floor" ? Math.floor(number) : operation === "ceil" ? Math.ceil(number) : Math.abs(number);
  return finiteNumber(result, `$${operation}`);
};

const safeSubstring = (input: unknown, start: unknown, length?: unknown): string | undefined => {
  if (input === undefined) return undefined;
  const text = requireBoundedString(input, "$substring");
  if (typeof start !== "number" || !Number.isFinite(start) ||
      (length !== undefined && (typeof length !== "number" || !Number.isFinite(length)))) {
    throw new Error("API source $substring requires finite numeric positions.");
  }
  const characters = Array.from(text);
  const index = Math.trunc(start);
  const end = length === undefined ? undefined : index + Math.trunc(length);
  return characters.slice(index, end).join("").slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

const safeSubstringBefore = (input: unknown, search: unknown): string | undefined => {
  if (input === undefined) return undefined;
  const text = requireBoundedString(input, "$substringBefore");
  const needle = requireBoundedString(search, "$substringBefore");
  const index = text.indexOf(needle);
  return (index < 0 ? "" : text.slice(0, index)).slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

const safeSubstringAfter = (input: unknown, search: unknown): string | undefined => {
  if (input === undefined) return undefined;
  const text = requireBoundedString(input, "$substringAfter");
  const needle = requireBoundedString(search, "$substringAfter");
  const index = text.indexOf(needle);
  return (index < 0 ? "" : text.slice(index + needle.length)).slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

const safeSplit = (input: unknown, separator: unknown, limit: unknown = JSONATA_LIMITS.maximumSequenceLength): string[] | undefined => {
  if (input === undefined) return undefined;
  const text = requireBoundedString(input, "$split");
  const delimiter = requireBoundedString(separator, "$split");
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 ||
      limit > JSONATA_LIMITS.maximumSequenceLength) {
    throw new Error("API source $split requires a bounded integer limit.");
  }
  return text.split(delimiter, limit);
};

const safeReplace = (input: unknown, pattern: unknown, replacement: unknown, limit: unknown): string | undefined => {
  if (input === undefined) return undefined;
  const text = requireBoundedString(input, "$replace");
  const needle = requireBoundedString(pattern, "$replace");
  const substitute = requireBoundedString(replacement, "$replace");
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 ||
      limit > JSONATA_LIMITS.maximumReplaceLimit || needle.length === 0) {
    throw new Error("API source $replace requires a bounded integer limit and non-empty pattern.");
  }
  let result = "";
  let position = 0;
  let count = 0;
  while (count < limit) {
    const match = text.indexOf(needle, position);
    if (match < 0) break;
    result = cappedAppend(result, text.slice(position, match));
    result = cappedAppend(result, substitute);
    position = match + needle.length;
    count += 1;
    if (result.length >= API_SOURCE_MAXIMUMS.outputLength) return result;
  }
  return cappedAppend(result, text.slice(position));
};

const safeFormatNumber = (value: unknown, picture: unknown = "0"): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("API source $formatNumber requires a finite number.");
  }
  if (typeof picture !== "string") throw new Error("API source $formatNumber requires a literal picture.");
  const options = formatNumberPictures.get(picture);
  if (options === undefined) throw new Error("API source $formatNumber picture is not allowed.");
  return new Intl.NumberFormat("en-US", options).format(value).slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

const safeFromMillis = (value: unknown, picture?: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("API source $fromMillis requires finite milliseconds.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("API source $fromMillis value is out of range.");
  if (picture === undefined) return date.toISOString();
  if (picture !== "[H01]:[m01]") throw new Error("API source $fromMillis picture is not allowed.");
  const twoDigits = (part: number): string => String(part).padStart(2, "0");
  return `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}`;
};

const readIsoDigits = (value: string, start: number, length: number): number => {
  let parsed = 0;
  for (let index = start; index < start + length; index += 1) {
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) throw new Error("API source $toMillis requires an ISO-8601 UTC timestamp.");
    parsed = parsed * 10 + digit;
  }
  return parsed;
};

const safeToMillis = (value: unknown, picture?: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (picture !== undefined) throw new Error("API source $toMillis accepts ISO-8601 UTC timestamps only.");
  if (typeof value !== "string" || (value.length !== 20 && value.length !== 24) ||
      value[4] !== "-" || value[7] !== "-" || value[10] !== "T" ||
      value[13] !== ":" || value[16] !== ":" ||
      (value.length === 20 ? value[19] !== "Z" : value[19] !== "." || value[23] !== "Z")) {
    throw new Error("API source $toMillis requires an ISO-8601 UTC timestamp.");
  }
  const year = readIsoDigits(value, 0, 4);
  const month = readIsoDigits(value, 5, 2);
  const day = readIsoDigits(value, 8, 2);
  const hour = readIsoDigits(value, 11, 2);
  const minute = readIsoDigits(value, 14, 2);
  const second = readIsoDigits(value, 17, 2);
  const millisecond = value.length === 24 ? readIsoDigits(value, 20, 3) : 0;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (month < 1 || month > 12 || day < 1 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 ||
      minute > 59 || second > 59) {
    throw new Error("API source $toMillis requires a valid ISO-8601 UTC timestamp.");
  }
  return date.getTime();
};

const aggregateValues = (value: unknown, functionName: string): unknown[] => {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (values.length > JSONATA_LIMITS.maximumAggregateLength) {
    throw new Error(`API source ${functionName} exceeded the aggregate limit.`);
  }
  return values;
};

const finiteNumber = (value: unknown, functionName: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`API source ${functionName} requires finite numbers.`);
  }
  return value;
};

const safeAggregate = (kind: "sum" | "average" | "max" | "min", value: unknown): number | undefined => {
  const values = aggregateValues(value, `$${kind}`);
  if (values.length === 0) return kind === "sum" ? 0 : undefined;
  let result = kind === "min" ? Number.POSITIVE_INFINITY : kind === "max" ? Number.NEGATIVE_INFINITY : 0;
  for (const entry of values) {
    const current = finiteNumber(entry, `$${kind}`);
    if (kind === "sum" || kind === "average") {
      result += current;
      if (!Number.isFinite(result)) throw new Error(`API source $${kind} produced a non-finite number.`);
    } else if (kind === "max") result = Math.max(result, current);
    else result = Math.min(result, current);
  }
  if (kind === "average") result /= values.length;
  return finiteNumber(result, `$${kind}`);
};

const safeCount = (value: unknown): number => aggregateValues(value, "$count").length;

const safeArithmetic = (left: unknown, right: unknown, operator: unknown): number | undefined => {
  if (left === undefined || right === undefined) return undefined;
  const lhs = finiteNumber(left, "arithmetic");
  const rhs = finiteNumber(right, "arithmetic");
  let result: number;
  switch (operator) {
    case "+": result = lhs + rhs; break;
    case "-": result = lhs - rhs; break;
    case "*": result = lhs * rhs; break;
    case "/": result = lhs / rhs; break;
    case "%": result = lhs % rhs; break;
    default: throw new Error("API source arithmetic operator is invalid.");
  }
  if (!Number.isFinite(result)) throw new Error("API source arithmetic produced a non-finite number.");
  return result;
};

const rewriteBoundedOperators = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const child of value) rewriteBoundedOperators(child);
    return;
  }
  if (!isNode(value)) return;
  for (const child of Object.values(value)) rewriteBoundedOperators(child);
  if (value.type !== "binary" || typeof value.value !== "string" ||
      (!arithmeticOperators.has(value.value) && value.value !== "&")) return;

  const operator = value.value;
  const position = value.position;
  const left = value.lhs;
  const right = value.rhs;
  value.type = "function";
  value.value = "(";
  value.arguments = [left, right, { type: "string", value: operator, position }];
  value.procedure = {
    type: "variable",
    value: operator === "&" ? "apiSourceConcat" : "apiSourceArithmetic",
    position,
  };
  delete value.lhs;
  delete value.rhs;
};

export const evaluateApiSourceExpression = async (expression: string, input: unknown): Promise<unknown> => {
  assertJsonDepth(input);
  if (expression.trim().length === 0) return input;
  const validationError = inspectApiSourceExpression(expression);
  if (validationError !== null) {
    if (validationError.kind === "construct_not_allowed") {
      throw new Error(`JSONata construct ${validationError.constructName} is not allowed.`);
    }
    throw new Error("API source JSONata expression is invalid or exceeds the evaluation limits.");
  }
  const compiled = jsonata(expression, {
    stack: JSONATA_LIMITS.stackDepth,
    sequence: JSONATA_LIMITS.maximumSequenceLength,
  });
  compiled.registerFunction("string", safeString);
  compiled.registerFunction("length", safeLength);
  compiled.registerFunction("substring", safeSubstring);
  compiled.registerFunction("substringBefore", safeSubstringBefore);
  compiled.registerFunction("substringAfter", safeSubstringAfter);
  compiled.registerFunction("uppercase", (value) => safeCase(value, true));
  compiled.registerFunction("lowercase", (value) => safeCase(value, false));
  compiled.registerFunction("trim", safeTrim);
  compiled.registerFunction("contains", safeContains);
  compiled.registerFunction("join", safeJoin);
  compiled.registerFunction("sum", (value) => safeAggregate("sum", value));
  compiled.registerFunction("max", (value) => safeAggregate("max", value));
  compiled.registerFunction("min", (value) => safeAggregate("min", value));
  compiled.registerFunction("average", (value) => safeAggregate("average", value));
  compiled.registerFunction("count", safeCount);
  compiled.registerFunction("number", safeNumber);
  compiled.registerFunction("round", safeRound);
  compiled.registerFunction("floor", (value) => safeMath(value, "floor"));
  compiled.registerFunction("ceil", (value) => safeMath(value, "ceil"));
  compiled.registerFunction("abs", (value) => safeMath(value, "abs"));
  compiled.registerFunction("formatNumber", safeFormatNumber);
  compiled.registerFunction("fromMillis", safeFromMillis);
  compiled.registerFunction("toMillis", safeToMillis);
  compiled.registerFunction("split", safeSplit);
  compiled.registerFunction("replace", safeReplace);
  compiled.registerFunction("apiSourceArithmetic", safeArithmetic);
  compiled.registerFunction("apiSourceConcat", (left, right) => cappedAppend(boundedString(left), boundedString(right)));
  rewriteBoundedOperators(compiled.ast());
  // The AST allowlist admits no user-defined functions; bounded wrappers cover
  // JSONata's picture, string, aggregate, and numeric implementations.
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
