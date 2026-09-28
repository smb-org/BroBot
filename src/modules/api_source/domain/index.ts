import jsonata from "jsonata";

import { API_SOURCE_MAXIMUMS } from "../contracts";

export const JSONATA_LIMITS = {
  timeoutMs: 10,
  stackDepth: 64,
  maximumSequenceLength: 1_000,
  maximumInputDepth: 64,
  maximumInputNodes: 20_000,
} as const;

const validatedInputs = new WeakSet<object>();

const assertJsonDepth = (value: unknown): void => {
  if (typeof value === "object" && value !== null && validatedInputs.has(value)) return;
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

export const validateJsonataExpression = (expression: string): boolean => {
  if (expression.length > API_SOURCE_MAXIMUMS.expressionLength) return false;
  if (expression.trim().length === 0) return true;
  try {
    jsonata(expression, { timeout: JSONATA_LIMITS.timeoutMs, stack: JSONATA_LIMITS.stackDepth, sequence: JSONATA_LIMITS.maximumSequenceLength });
    return true;
  } catch {
    return false;
  }
};

export const evaluateApiSourceExpression = async (expression: string, input: unknown): Promise<unknown> => {
  assertJsonDepth(input);
  if (expression.trim().length === 0) return input;
  const compiled = jsonata(expression, {
    timeout: JSONATA_LIMITS.timeoutMs,
    stack: JSONATA_LIMITS.stackDepth,
    sequence: JSONATA_LIMITS.maximumSequenceLength,
  });
  // No bindings, assigned variables, or extension functions are exposed.
  return await compiled.evaluate(input);
};

export const formatApiSourceValue = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, API_SOURCE_MAXIMUMS.outputLength);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) throw new Error("API source expression returned no value.");
  const serialized = JSON.stringify(value);
  return serialized.slice(0, API_SOURCE_MAXIMUMS.outputLength);
};

export const parseApiSourceName = (conditionId: string): string | null => {
  const match = /^api_source\.([a-z][a-z0-9_]{0,31})$/u.exec(conditionId);
  return match?.[1] ?? null;
};
