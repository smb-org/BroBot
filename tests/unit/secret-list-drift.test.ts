import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The configuration script exposes the drift-check hook as an ESM export.
import { checkSecretListDrift } from "../../scripts/verify-deployment-config.mjs";
import { getTokenEncryptionKeys } from "../../src/worker/auth/crypto";

type CheckSecretListDrift = (config: object, failures: string[]) => Promise<void>;
const checkSecretListDriftTyped = checkSecretListDrift as unknown as CheckSecretListDrift;

// Regression guard: REQUIRED_SECRET_NAMES (src/worker/index.ts),
// secrets.required (wrangler.jsonc), and deploymentBindings
// (scripts/verify-deployment-config.mjs) must match. Calls the
// verify script directly instead of rebuilding the extraction here.
describe("Secret name drift", () => {
  it("reports a mismatch in a secret list", async () => {
    const required = [
      "TWITCH_CLIENT_ID",
      "TWITCH_CLIENT_SECRET",
      "TWITCH_EVENTSUB_SECRET",
      "PUBLIC_ORIGIN",
      "SESSION_COOKIE_KEYS",
      "TOKEN_ENCRYPTION_KEYS",
      "OVERLAY_TOKEN_PEPPER",
      "BETREIBER_USER_IDS",
    ];
    const config = {
      secrets: { required: [...required] },
      env: {
        staging: { secrets: { required: [...required] } },
        production: { secrets: { required: [...required] } },
      },
    };
    config.env.production.secrets.required = config.env.production.secrets.required
      .filter((name) => name !== "OVERLAY_TOKEN_PEPPER");
    const failures: string[] = [];

    await checkSecretListDriftTyped(config, failures);

    expect(failures).toEqual(expect.arrayContaining([
      expect.stringContaining("OVERLAY_TOKEN_PEPPER"),
    ]));
  });

  it("fails when the three secret lists diverge", () => {
    const result = spawnSync("node", ["scripts/verify-deployment-config.mjs"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a 31-byte overlay pepper in the preflight", () => {
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
      `TOKEN_ENCRYPTION_KEYS='${keyRing}'`,
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

  it("rejects an overlay pepper misused as a key ring", () => {
    const key = Buffer.alloc(32, 1).toString("base64url");
    const keyRing = JSON.stringify({ active: { id: "pepper-v2", key }, retired: [] });
    const tokenKeyRing = JSON.stringify({ active: { id: "token-v1", key }, retired: [] });
    const directory = mkdtempSync(path.join(os.tmpdir(), "brobot-config-pepper-ring-"));
    const environmentFile = path.join(directory, "staging.env");
    writeFileSync(environmentFile, [
      "TWITCH_CLIENT_ID=client-id",
      "TWITCH_CLIENT_SECRET=client-secret",
      `TWITCH_EVENTSUB_SECRET='${tokenKeyRing}'`,
      "PUBLIC_ORIGIN=https://brobot.example",
      `SESSION_COOKIE_KEYS='${tokenKeyRing}'`,
      `TOKEN_ENCRYPTION_KEYS='${tokenKeyRing}'`,
      `OVERLAY_TOKEN_PEPPER='${keyRing}'`,
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

  it("rejects a non-absolute PUBLIC_ORIGIN in the preflight", () => {
    const key = Buffer.alloc(32, 1).toString("base64url");
    const keyRing = JSON.stringify({ active: { id: "test-key", key }, retired: [] });
    const directory = mkdtempSync(path.join(os.tmpdir(), "brobot-config-origin-"));
    const environmentFile = path.join(directory, "staging.env");
    writeFileSync(environmentFile, [
      "TWITCH_CLIENT_ID=client-id",
      "TWITCH_CLIENT_SECRET=client-secret",
      `TWITCH_EVENTSUB_SECRET='${keyRing}'`,
      "PUBLIC_ORIGIN=not-a-url",
      `SESSION_COOKIE_KEYS='${keyRing}'`,
      `TOKEN_ENCRYPTION_KEYS='${keyRing}'`,
      `OVERLAY_TOKEN_PEPPER=${key}`,
      "",
    ].join("\n"));

    try {
      const result = spawnSync(
        "node",
        ["scripts/verify-deployment-config.mjs", "validate-env", "staging", environmentFile],
        { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("PUBLIC_ORIGIN");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts the old token key during the transition period", () => {
    const keyRing = JSON.stringify({
      active: { id: "legacy", key: Buffer.alloc(32, 1).toString("base64url") },
      retired: [],
    });

    expect(getTokenEncryptionKeys({ SESSION_ENCRYPTION_KEYS: keyRing })).toBe(keyRing);
    expect(getTokenEncryptionKeys({
      TOKEN_ENCRYPTION_KEYS: "neu",
      SESSION_ENCRYPTION_KEYS: keyRing,
    })).toBe("neu");
  });

  it("accepts the old token key name in the deployment preflight too", () => {
    const key = Buffer.alloc(32, 1).toString("base64url");
    const keyRing = JSON.stringify({ active: { id: "test-key", key }, retired: [] });
    const directory = mkdtempSync(path.join(os.tmpdir(), "brobot-config-legacy-key-"));
    const environmentFile = path.join(directory, "staging.env");
    writeFileSync(environmentFile, [
      "TWITCH_CLIENT_ID=client-id",
      "TWITCH_CLIENT_SECRET=client-secret",
      `TWITCH_EVENTSUB_SECRET='${keyRing}'`,
      "PUBLIC_ORIGIN=https://brobot.example",
      `SESSION_COOKIE_KEYS='${keyRing}'`,
      `SESSION_ENCRYPTION_KEYS='${keyRing}'`,
      `OVERLAY_TOKEN_PEPPER=${key}`,
      "BETREIBER_USER_IDS=[]",
      "",
    ].join("\n"));

    try {
      const result = spawnSync(
        "node",
        ["scripts/verify-deployment-config.mjs", "validate-env", "staging", environmentFile],
        { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
