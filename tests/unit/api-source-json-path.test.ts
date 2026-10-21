import { describe, expect, it } from "vitest";

import { createApiSourceJsonPath, evaluateApiSourceExpression } from "../../src/modules/api_source/domain";

type PathSegment = string | number;

const collectLeaves = (value: unknown, path: PathSegment[] = []): { path: PathSegment[]; value: unknown }[] => {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path, value }];
    return value.flatMap((entry, index) => collectLeaves(entry, [...path, index]));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [{ path, value }];
    return entries.flatMap(([key, entry]) => collectLeaves(entry, [...path, key]));
  }
  return [{ path, value }];
};

describe("API source JSON paths", () => {
  it("round-trips every leaf through the API source expression evaluator", async () => {
    const json = {
      simple: "dot access",
      "with space": "quoted space",
      "dot.key": "quoted dot",
      'quote"key': "escaped quote",
      "2first": "digit first",
      "café": "unicode",
      "": "empty key",
      "true": "reserved keyword",
      nested: [{ "inside.array": [false, { value: null }] }],
      emptyArray: [],
      emptyObject: {},
    };

    for (const leaf of collectLeaves(json)) {
      const generated = createApiSourceJsonPath(leaf.path);
      expect(generated.expression, JSON.stringify(leaf.path)).not.toBeNull();
      await expect(evaluateApiSourceExpression(generated.expression ?? "", json), JSON.stringify(leaf.path))
        .resolves.toEqual(leaf.value);
    }
  });

  it("round-trips leaves from a root array through numeric root paths", async () => {
    const json = [1, { v: 2 }, { v: 3 }];

    for (const leaf of collectLeaves(json)) {
      const generated = createApiSourceJsonPath(leaf.path);
      expect(generated.expression, JSON.stringify(leaf.path)).not.toBeNull();
      await expect(evaluateApiSourceExpression(generated.expression ?? "", json), JSON.stringify(leaf.path))
        .resolves.toEqual(leaf.value);
    }

    expect(createApiSourceJsonPath([0, "v"]).expression).toBe("$[0].v");
    await expect(evaluateApiSourceExpression("$[0]", json)).resolves.toBe(1);
  });

  it("uses dot, quoted-name, and array-index syntax from the evaluator", () => {
    expect(createApiSourceJsonPath(["safe_name"]).expression).toBe("$.safe_name");
    expect(createApiSourceJsonPath(["two words"]).expression).toBe(`$.${JSON.stringify("two words")}`);
    expect(createApiSourceJsonPath(["true"]).expression).toBe(`$.${JSON.stringify("true")}`);
    expect(createApiSourceJsonPath(["items", 0]).expression).toBe("$.items[0]");
    expect(createApiSourceJsonPath([0]).expression).toBe("$[0]");
  });

  it("explains paths the evaluator rejects instead of returning an unusable expression", () => {
    const generated = createApiSourceJsonPath(["x".repeat(600)]);

    expect(generated).toEqual({ expression: null, reason: "too_long" });
    expect(createApiSourceJsonPath([-1])).toEqual({ expression: null, reason: "unsupported" });
    expect(createApiSourceJsonPath([1.5])).toEqual({ expression: null, reason: "unsupported" });
  });

  it("rejects unsafe root indexes and predicates on named variables", async () => {
    for (const expression of ["$[-1]", "$[1.5]", "$[9007199254740992]", "$items[0]"]) {
      await expect(evaluateApiSourceExpression(expression, [{ v: 1 }])).rejects.toThrow("JSONata construct");
    }
  });
});
