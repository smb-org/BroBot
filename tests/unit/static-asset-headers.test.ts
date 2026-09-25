// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const parseHeadersFile = (source: string): Map<string, Map<string, string>> => {
  const rules = new Map<string, Map<string, string>>();
  let currentRule: Map<string, string> | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (/^\s/.test(line)) {
      const separator = trimmed.indexOf(":");
      if (currentRule === undefined || separator < 1) continue;
      currentRule.set(
        trimmed.slice(0, separator).toLowerCase(),
        trimmed.slice(separator + 1).trim(),
      );
      continue;
    }

    currentRule = new Map();
    rules.set(trimmed, currentRule);
  }

  return rules;
};

const headersFile = readFileSync(
  path.join(import.meta.dirname, "../../public/_headers"),
  "utf8",
);
const rules = parseHeadersFile(headersFile);

describe("Cloudflare static asset headers", () => {
  it.each(["/_app/*", "/fonts/*"])("allows opaque-origin reads for %s", (path) => {
    const headers = rules.get(path);

    expect(headers?.get("access-control-allow-origin")).toBe("*");
    expect(headers?.has("access-control-allow-credentials")).toBe(false);
  });
});
