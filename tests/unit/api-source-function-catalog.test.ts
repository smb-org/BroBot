import { describe, expect, it } from "vitest";

import { API_SOURCE_FUNCTION_CATALOG } from "../../src/modules/api_source/contracts/function-catalog";
import { ALLOWED_FUNCTIONS, evaluateApiSourceExpression } from "../../src/modules/api_source/domain";

describe("API source function catalogue", () => {
  it("contains each allowed function exactly once", () => {
    const names = API_SOURCE_FUNCTION_CATALOG.map(({ name }) => name);
    expect(new Set(names)).toEqual(ALLOWED_FUNCTIONS);
    expect(names).toHaveLength(ALLOWED_FUNCTIONS.size);
  });

  it("provides both localized descriptions and one example for every function", () => {
    for (const entry of API_SOURCE_FUNCTION_CATALOG) {
      expect(entry.description.de.trim(), `${entry.name} German description`).not.toBe("");
      expect(entry.description.en.trim(), `${entry.name} English description`).not.toBe("");
      expect(entry.example.trim(), `${entry.name} example`).not.toBe("");
    }
  });

  it("catalogues bounded string length under text and collection counting under lists", () => {
    expect(API_SOURCE_FUNCTION_CATALOG.find(({ name }) => name === "length")).toMatchObject({
      group: "text",
      signature: "length(text)",
      description: {
        de: "Zählt die Zeichen einer begrenzten Zeichenkette.",
        en: "Counts the characters in a bounded string.",
      },
    });
    expect(API_SOURCE_FUNCTION_CATALOG.find(({ name }) => name === "count")?.group).toBe("list");
  });

  it("evaluates every catalogue example with the real API source evaluator", async () => {
    const payload = {
      user: "viewer",
      days: ["Mo", "Di"],
      daysText: "Mo,Di",
      items: [1, 2],
      amount: 1234,
      rates: { EUR: 0.92 },
      daily: { sunset: ["2026-10-12T18:42:00Z"] },
    };

    for (const entry of API_SOURCE_FUNCTION_CATALOG) {
      const expression = entry.example.split(" → ")[0];
      expect(expression, `${entry.name} example expression`).toBeTruthy();
      await expect(evaluateApiSourceExpression(expression ?? "", payload), `${entry.name} example`).resolves.not.toBeUndefined();
    }
  });
});
