import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");

const runOrigin = (environment: string, configPath?: string) => spawnSync(
  "node",
  [
    "scripts/check-health.mjs",
    "--print-origin",
    environment,
    ...(configPath === undefined ? [] : [configPath]),
  ],
  { cwd: projectRoot, encoding: "utf8" },
);

const withTemporaryConfig = (source: string, callback: (configPath: string) => void) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "brobot-health-"));
  const configPath = path.join(directory, "wrangler.jsonc");
  writeFileSync(configPath, source);
  try {
    callback(configPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("Deployment-Healthcheck", () => {
  it("löst die Staging-Origin aus wrangler.jsonc auf", () => {
    const result = runOrigin("staging");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "https://brobot-staging.esembe.app",
    );
  });

  it("akzeptiert einen nachgestellten Kommentar hinter dem Routenmuster", () => {
    withTemporaryConfig(`{
      "env": {
        "staging": {
          "routes": [{ "pattern": "inline.example" }] // gültiger JSONC-Kommentar
        }
      }
    }`, (configPath) => {
      const result = runOrigin("staging", configPath);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("https://inline.example");
    });
  });

  it("akzeptiert ein überzähliges Komma in der JSONC-Konfiguration", () => {
    withTemporaryConfig(`{
      "env": {
        "production": {
          "routes": [{ "pattern": "trailing.example", }],
        },
      },
    }`, (configPath) => {
      const result = runOrigin("production", configPath);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("https://trailing.example");
    });
  });
});
