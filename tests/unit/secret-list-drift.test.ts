import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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

  it("weist im Preflight einen 31-Byte-Overlay-Pepper ab", () => {
    const key = Buffer.alloc(32, 1).toString("base64url");
    const malformedPepper = Buffer.alloc(31, 4).toString("base64url");
    const keyRing = JSON.stringify({ active: { id: "test-key", key }, retired: [] });
    const directory = mkdtempSync(path.join(os.tmpdir(), "brobot-config-"));
    const environmentFile = path.join(directory, "staging.env");
    writeFileSync(environmentFile, [
      "TWITCH_CLIENT_ID=client-id",
      "TWITCH_CLIENT_SECRET=client-secret",
      `TWITCH_EVENTSUB_SECRET='${keyRing}'`,
      "PUBLIC_ORIGIN=https://brobot.example",
      `SESSION_COOKIE_KEYS='${keyRing}'`,
      `SESSION_ENCRYPTION_KEYS='${keyRing}'`,
      `OVERLAY_TOKEN_PEPPER=${malformedPepper}`,
      "",
    ].join("\n"));

    try {
      const result = spawnSync(
        "node",
        ["scripts/verify-deployment-config.mjs", "validate-env", "staging", environmentFile],
        { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("OVERLAY_TOKEN_PEPPER");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
