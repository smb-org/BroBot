import { describe, expect, it } from "vitest";

import { API_SOURCE_FUNCTION_CATALOG } from "../../src/modules/api_source/contracts/function-catalog";
import { ALLOWED_FUNCTIONS } from "../../src/modules/api_source/domain";

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
});
