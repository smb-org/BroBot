// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The shared configuration module is an executable ESM script.
import { readWranglerConfig } from "../../scripts/read-wrangler-config.mjs";

const readWranglerConfigTyped = readWranglerConfig as unknown as (configPath: string) => Promise<unknown>;

describe("shared Wrangler config reader", () => {
  it("accepts trailing comments and trailing commas like Wrangler", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "brobot-wrangler-config-"));
    const configPath = path.join(directory, "wrangler.jsonc");
    writeFileSync(configPath, `{
      "env": {
        "staging": {
          "routes": [{ "pattern": "inline.example", }] // gültiger JSONC-Kommentar
        },
      },
    }`);

    try {
      const config = await readWranglerConfigTyped(configPath) as {
        env?: { staging?: { routes?: Array<{ pattern?: string }> } };
      };
      expect(config.env?.staging?.routes?.[0]?.pattern).toBe("inline.example");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
