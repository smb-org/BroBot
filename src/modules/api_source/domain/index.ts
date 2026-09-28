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
    if (validationError.kind === "construct_not_allowed") {
      throw new Error(`JSONata construct ${validationError.constructName} is not allowed.`);
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
  // The AST allowlist leaves only approved JSONata functions; these
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
