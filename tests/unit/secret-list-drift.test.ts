import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Regressionsschutz: REQUIRED_SECRET_NAMES (src/worker/index.ts),
// secrets.required (wrangler.jsonc) und deploymentBindings
// (scripts/verify-deployment-config.mjs) müssen übereinstimmen. Ruft direkt
// das Verify-Script auf statt die Extraktion hier nachzubauen.
describe("Secret-Namen-Drift", () => {
  it("scheitert, wenn die drei Secret-Listen auseinanderlaufen", () => {
    const result = spawnSync("node", ["scripts/verify-deployment-config.mjs"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
