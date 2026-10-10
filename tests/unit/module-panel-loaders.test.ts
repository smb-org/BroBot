import { describe, expect, it } from "vitest";

import { memoizedModuleLoad } from "../../src/dashboard/module-panel-loaders";

describe("module chunk loader cache", () => {
  it("evicts a rejected import so a later attempt can succeed", async () => {
    let attempts = 0;
    const moduleId = "recoverable-loader-test";

    await expect(memoizedModuleLoad(moduleId, "panel", () => {
      attempts += 1;
      return Promise.reject(new Error("chunk unavailable"));
    })).rejects.toThrow("chunk unavailable");

    await expect(memoizedModuleLoad(moduleId, "panel", () => {
      attempts += 1;
      return Promise.resolve("loaded");
    })).resolves.toBe("loaded");

    expect(attempts).toBe(2);
  });
});
