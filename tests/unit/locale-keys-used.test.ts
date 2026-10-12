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
  constKey: string;
  unionKey: string;
  unionAlternateKey: string;
  keyofKey: string;
  usedKey: string;
  orphanKey: string;
  nested: {
    nestedUsedKey: string;
    nestedOrphanKey: string;
  };
}

const catalog: Record<"de" | "en", FixtureTexts> = {
  de: { constKey: "Konstante", unionKey: "Vereinigung", unionAlternateKey: "Alternative", keyofKey: "Schlüssel", usedKey: "Beispiel", orphanKey: "Ungenutzt", nested: { nestedUsedKey: "Verwendet", nestedOrphanKey: "Ungenutzt" } },
  en: { constKey: "Constant", unionKey: "Union", unionAlternateKey: "Alternate", keyofKey: "Key", usedKey: "Example", orphanKey: "Unused", nested: { nestedUsedKey: "Used", nestedOrphanKey: "Unused" } },
};

const constKey = "constKey" as const;
const unionKey: "unionKey" | "unionAlternateKey" = Math.random() ? "unionKey" : "unionAlternateKey";
const keyofKey: keyof Pick<FixtureTexts, "keyofKey"> = "keyofKey";

export const readUsedKey = (language: "de" | "en"): string => catalog[language][constKey]
  + catalog.de[unionKey]
  + catalog.en[keyofKey]
  + catalog[language].usedKey
  + catalog[language].nested.nestedUsedKey;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/locale.ts#FixtureTexts", key: "orphanKey" },
      { catalog: "src/dashboard/locale.ts#FixtureTexts.nested", key: "nestedOrphanKey" },
    ]);
  });

  it("checks keys in catalogues inferred from object initializers", () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), "brobot-inferred-locale-keys-"));
    temporaryDirectories.push(projectRoot);
    mkdirSync(path.join(projectRoot, "src/modules/sample/panel"), { recursive: true });
    writeFileSync(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(path.join(projectRoot, "src/modules/sample/panel/locale.ts"), `
const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;

export const readLiveLabel = (language: "de" | "en"): string => {
  const key = "live" as const;
  return catalog[language][key];
};
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/modules/sample/panel/locale.ts#catalog", key: "orphan" },
    ]);
  });
});
