import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

describe("CI Playwright image", () => {
  it("uses the @playwright/test version resolved in pnpm-lock.yaml", () => {
    const lockedVersion = /^ {6}'@playwright\/test':\n {8}specifier: [^\n]+\n {8}version: ([^\n]+)$/m.exec(lockfile)?.[1];
    const imageVersion = /^\s+image: mcr\.microsoft\.com\/playwright:v([^\s]+)-noble\s*$/m.exec(workflow)?.[1];

    expect(lockedVersion).toBeDefined();
    expect(imageVersion).toBe(lockedVersion);
  });
});
