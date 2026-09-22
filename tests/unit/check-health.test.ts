import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The executable healthcheck script exposes test hooks as ESM exports.
import { checkHealth, resolveDeploymentOriginFromConfig } from "../../scripts/check-health.mjs";

type DeploymentConfig = { env?: Record<string, { routes?: Array<{ pattern?: string }> }> };
type HealthcheckOptions = {
  fetchImplementation?: typeof fetch;
  waitImplementation?: (milliseconds: number) => Promise<void>;
};
type CheckHealth = (
  environment: string,
  configPath?: string,
  originOverride?: string,
  options?: HealthcheckOptions,
) => Promise<void>;
type ResolveDeploymentOriginFromConfig = (config: DeploymentConfig, environment: string) => string;

const checkHealthTyped = checkHealth as unknown as CheckHealth;
const resolveDeploymentOriginFromConfigTyped =
  resolveDeploymentOriginFromConfig as unknown as ResolveDeploymentOriginFromConfig;

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

const runHealth = (origin: string) => spawnSync(
  "node",
  ["scripts/check-health.mjs", "--origin", origin],
  {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, CHECK_HEALTH_RETRY_DELAY_MS: "0" },
  },
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

const configForRoute = (pattern: string) => ({
  env: {
    staging: {
      routes: [{ pattern }],
    },
  },
});

const rejectedRoutes = [
  { pattern: "http://insecure.example", reason: "https" },
  { pattern: "https://user:pass@secure.example", reason: "Benutzername und Passwort" },
  { pattern: "https://secure.example/worker", reason: "Pfad" },
  { pattern: "https://secure.example?version=1", reason: "Query" },
] as const;

describe("deployment healthcheck", () => {
  it("resolves the staging origin from wrangler.jsonc", () => {
    const result = runOrigin("staging");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "https://brobot-staging.esembe.app",
    );
  });

  it("accepts a trailing comment after the route pattern", () => {
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

  it("accepts a trailing comma in the JSONC configuration", () => {
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

  it("fails clearly when all healthcheck attempts fail", () => {
    const result = runHealth("https://127.0.0.1:1");

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Healthcheck nach 6 Versuchen fehlgeschlagen",
    );
  });

  it("rejects an unhealthy payload despite HTTP 200", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "misconfigured",
      missingBindings: ["DB_SCHEMA"],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(checkHealthTyped("staging", undefined, "https://brobot.example", {
      fetchImplementation: fetcher,
      waitImplementation: async () => {},
    })).rejects.toThrow("Healthcheck nach 6 Versuchen fehlgeschlagen");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each(rejectedRoutes)(
    "rejects a route with $reason before fetch is called",
    async ({ pattern, reason }) => {
      expect(() => resolveDeploymentOriginFromConfigTyped(configForRoute(pattern), "staging"))
        .toThrow(`Konfiguration wrangler.jsonc`);

      const fetcher = vi.fn() as unknown as typeof fetch;
      const healthcheck = checkHealthTyped("staging", undefined, pattern, {
        fetchImplementation: fetcher,
        waitImplementation: async () => {},
      });
      await expect(healthcheck).rejects.toThrow(`Konfiguration wrangler.jsonc`);
      await expect(healthcheck).rejects.toThrow(reason);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
