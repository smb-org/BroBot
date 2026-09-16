import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";

describe("Browser-Vitest-Grundgerüst", () => {
  it("startet mit einer leeren Modulregistrierung", () => {
    expect(MODULES).toEqual([]);
  });
});
