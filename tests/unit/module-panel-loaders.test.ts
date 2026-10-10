import { describe, expect, it } from "vitest";

import { memoizedModuleLoad } from "../../src/dashboard/module-panel-loaders";

describe("module chunk loader cache", () => {
  it("returns the same pending or fulfilled promise for repeated loads", async () => {
    let attempts = 0;
    const moduleId = "memoized-loader-test";
    const loader = (): Promise<string> => {
      attempts += 1;
      return Promise.resolve("loaded");
    };

    const first = memoizedModuleLoad(moduleId, "settingsEditor", loader);
    const second = memoizedModuleLoad(moduleId, "settingsEditor", loader);

    expect(second).toBe(first);
    await expect(first).resolves.toBe("loaded");
    expect(attempts).toBe(1);
  });

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
