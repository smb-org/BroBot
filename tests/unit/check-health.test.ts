import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Deployment-Healthcheck", () => {
  it("löst die Staging-Origin aus wrangler.jsonc auf", () => {
    const result = spawnSync(
      "node",
      ["scripts/check-health.mjs", "--print-origin", "staging"],
      { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "https://brobot-staging.esembe.app",
    );
  });
});
