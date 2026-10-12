import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unusedLocaleKeys } from "../../scripts/locale-key-usage";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("unused locale keys", () => {
  it("finds no unused keys in the application catalogues", () => {
    expect(unusedLocaleKeys()).toEqual([]);
  }, 15_000);

  it("reports an interface property without a reference outside its catalogue", () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), "brobot-locale-keys-"));
    temporaryDirectories.push(projectRoot);
    mkdirSync(path.join(projectRoot, "src/dashboard"), { recursive: true });
    writeFileSync(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(path.join(projectRoot, "src/dashboard/locale.ts"), `
interface FixtureTexts {
  usedKey: string;
  orphanKey: string;
  nested: {
    nestedUsedKey: string;
    nestedOrphanKey: string;
  };
}

const catalog: Record<"de" | "en", FixtureTexts> = {
  de: { usedKey: "Beispiel", orphanKey: "Ungenutzt", nested: { nestedUsedKey: "Verwendet", nestedOrphanKey: "Ungenutzt" } },
  en: { usedKey: "Example", orphanKey: "Unused", nested: { nestedUsedKey: "Used", nestedOrphanKey: "Unused" } },
};

export const readUsedKey = (language: "de" | "en"): string => catalog[language].usedKey + catalog[language].nested.nestedUsedKey;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/locale.ts#FixtureTexts", key: "orphanKey" },
      { catalog: "src/dashboard/locale.ts#FixtureTexts.nested", key: "nestedOrphanKey" },
    ]);
  });
});
