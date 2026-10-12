import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unusedLocaleKeys } from "../../scripts/locale-key-usage";

const temporaryDirectories: string[] = [];

const createLocaleFixture = (source: string): string => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "brobot-locale-fixture-"));
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
  writeFileSync(path.join(projectRoot, "src/dashboard/locale.ts"), source);
  return projectRoot;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("unused locale keys", () => {
  it("finds no unused keys in the application catalogues", () => {
    expect(unusedLocaleKeys()).toEqual([]);
  }, 60_000);

  it("does not count test-only reads as application catalogue usage", () => {
    const projectRoot = createLocaleFixture(`
export const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;
`);
    mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
    writeFileSync(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }));
    writeFileSync(path.join(projectRoot, "src/dashboard/usage.ts"), `
import { catalog } from "./locale";

export const readLive = (): string => catalog.en.live;
`);
    writeFileSync(path.join(projectRoot, "tests/catalog.test.ts"), `
import { catalog } from "../src/dashboard/locale";

export const testRead = (): string => catalog.en.orphan;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/locale.ts#catalog", key: "orphan" },
    ]);
  });

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
      { catalog: "src/dashboard/locale.ts#catalog", key: "orphanKey" },
      { catalog: "src/dashboard/locale.ts#catalog.nested", key: "nestedOrphanKey" },
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

  it("resolves catalogue members imported through a namespace", () => {
    const projectRoot = createLocaleFixture(`
export const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;
`);
    writeFileSync(path.join(projectRoot, "src/dashboard/usage.ts"), `
import * as locale from "./locale";

export const readLive = (): string => locale.catalog.en.live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/locale.ts#catalog", key: "orphan" },
    ]);
  });

  it("fails safe for a catalogue used as a shorthand assignment default", () => {
    const projectRoot = createLocaleFixture(`
const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;

let chosen: typeof catalog | undefined;
({ chosen = catalog } = {});
export const readLive = (): string => chosen?.en.live ?? "";
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("fails safe for bracket access to a namespace catalogue", () => {
    const projectRoot = createLocaleFixture(`
export const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;
`);
    writeFileSync(path.join(projectRoot, "src/dashboard/usage.ts"), `
import * as locale from "./locale";

export const readLive = (): string => locale["catalog"].en.live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("fails safe when destructuring a catalogue from a namespace import", () => {
    const projectRoot = createLocaleFixture(`
export const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;
`);
    writeFileSync(path.join(projectRoot, "src/dashboard/usage.ts"), `
import * as locale from "./locale";

const { catalog } = locale;
export const readLive = (): string => catalog.en.live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("counts shorthand catalogue properties as value references", () => {
    const projectRoot = createLocaleFixture(`
const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;

const aggregate = { catalog };
export const readLive = (): string => aggregate.catalog.en.live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("resolves referenced catalogue types and destructured property reads", () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), "brobot-annotated-locale-keys-"));
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
    writeFileSync(path.join(projectRoot, "src/dashboard/module-labels.ts"), `
interface ModuleStatus {
  running: string;
  disabled: string;
  nested: {
    active: string;
    orphan: string;
  };
}

type LocaleCatalog<T> = { de: T; en: T };
const moduleStatus: LocaleCatalog<ModuleStatus> = {
  de: { running: "Läuft", disabled: "Deaktiviert", nested: { active: "Aktiv", orphan: "Ungenutzt" } },
  en: { running: "Running", disabled: "Disabled", nested: { active: "Active", orphan: "Unused" } },
};

export const readStatus = (): string => {
  const { running, nested: { active: nestedActive } } = moduleStatus.de;
  return running + nestedActive;
};
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/module-labels.ts#moduleStatus", key: "disabled" },
      { catalog: "src/dashboard/module-labels.ts#moduleStatus.nested", key: "orphan" },
    ]);
  });

  it("does not infer catalogue usage from unrelated objects with similar properties", () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), "brobot-unrelated-locale-keys-"));
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
  de: { title: "Titel", loading: "Lädt", orphan: "Ungenutzt" },
  en: { title: "Title", loading: "Loading", orphan: "Unused" },
} as const;

const unrelated = { title: "Other title", loading: "Other loading", orphan: 42 };

export const readLabels = (): string => catalog.de.title + catalog.en.loading
  + unrelated.title + unrelated.loading + String(unrelated.orphan);
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/modules/sample/panel/locale.ts#catalog", key: "orphan" },
    ]);
  });

  it("treats nested typed assignments as consuming their catalogue value", () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), "brobot-locale-flow-keys-"));
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
interface DisplayTexts {
  used: string;
  orphan: string;
}

interface DisplayProps {
  labels: DisplayTexts;
}

const catalog = {
  de: { used: "Verwendet", orphan: "Ungenutzt" },
  en: { used: "Used", orphan: "Unused" },
} as const;

const display = ({ labels }: DisplayProps): string => labels.used;
const props: DisplayProps = { labels: catalog.de };
export const readUsedLabel = (): string => display(props);
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("does not connect unrelated values through shared type symbols", () => {
    const projectRoot = createLocaleFixture(`
interface SharedTexts {
  live: string;
  orphan: string;
}

const catalog: Record<"de" | "en", SharedTexts> = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
};
const unrelated: SharedTexts = { live: "Other", orphan: "Other" };

export const readUnrelated = (): string => unrelated.orphan;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/locale.ts#catalog", key: "live" },
      { catalog: "src/dashboard/locale.ts#catalog", key: "orphan" },
    ]);
  });

  it("collects concrete keys from index-signature catalogues", () => {
    const projectRoot = createLocaleFixture(`
interface NestedIndexedTexts {
  nested: Record<string, string>;
}

const catalog: Record<"de" | "en", Record<string, string>> = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
};
const nestedCatalog: Record<"de" | "en", NestedIndexedTexts> = {
  de: { nested: { live: "Verwendet", orphan: "Ungenutzt" } },
  en: { nested: { live: "Used", orphan: "Unused" } },
};

export const readLive = (): string => catalog.de.live;
export const readNestedLive = (): string => nestedCatalog.de.nested.live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/locale.ts#catalog", key: "orphan" },
      { catalog: "src/dashboard/locale.ts#nestedCatalog.nested", key: "orphan" },
    ]);
  });

  it("treats unsupported catalogue flows as consuming their source values", () => {
    const projectRoot = createLocaleFixture(`
interface ArgumentTexts { live: string; orphan: string }
interface ReturnedTexts { live: string; orphan: string }
interface AssignedTexts { live: string; orphan: string }
interface FlowSource { live: string; orphan: string }
interface FlowTarget { live: string; orphan: string }
interface DestructuredTexts { live: string; orphan: string }
interface NestedTexts { live: string; orphan: string }

const argumentCatalog: Record<"de" | "en", ArgumentTexts> = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
};
declare function consumeArgument(value: ArgumentTexts): void;
consumeArgument(argumentCatalog.de);

const returnedCatalog: Record<"de" | "en", ReturnedTexts> = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
};
const returnValue = (): ReturnedTexts => returnedCatalog.de;
const blockReturn = (): ReturnedTexts => { return returnedCatalog.en; };

const assignedCatalog: Record<"de" | "en", AssignedTexts> = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
};
let assigned: AssignedTexts;
assigned = assignedCatalog.de;

const flowCatalog: Record<"de" | "en", FlowSource> = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
};
function readBeforeSource(): string {
  const target: FlowTarget = source;
  return target.live;
}
const source: FlowSource = flowCatalog.de;

const destructuredCatalog: Record<"de" | "en", DestructuredTexts> = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
};
let live: string;
({ live } = destructuredCatalog.de);

const nestedCatalog: Record<"de" | "en", { nested: NestedTexts }> = {
  de: { nested: { live: "Verwendet", orphan: "Ungenutzt" } },
  en: { nested: { live: "Used", orphan: "Unused" } },
};
const { nested: nestedGroup } = nestedCatalog.de;
void nestedGroup.live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("collects nullable nested catalogue groups", () => {
    const projectRoot = createLocaleFixture(`
interface NestedTexts { live: string; orphan: string }
interface NullableTexts { nested: NestedTexts | null }

const catalog: Record<"de" | "en", NullableTexts> = {
  de: { nested: { live: "Verwendet", orphan: "Ungenutzt" } },
  en: { nested: { live: "Used", orphan: "Unused" } },
};

export const readLive = (): string | undefined => catalog.de.nested?.live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/locale.ts#catalog.nested", key: "orphan" },
    ]);
  });

  it("treats Object.values enumeration as consuming a whole catalogue group", () => {
    const projectRoot = createLocaleFixture(`
const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;

export const allValues = (): string => Object.values(catalog.de).join(",");
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("treats bracket-selected groups as consumed when passed, returned, or assigned", () => {
    const projectRoot = createLocaleFixture(`
const catalog = {
  de: { nested: { live: "Verwendet", orphan: "Ungenutzt" } },
  en: { nested: { live: "Used", orphan: "Unused" } },
} as const;

declare function consume(values: readonly string[]): void;
consume(Object.values(catalog.de["nested"]));

export const returnValues = (): string[] => Object.values(catalog.en["nested"]);
export const assignedValues: string[] = Object.values(catalog.en["nested"]);
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("omits the language when destructuring a translated text from the catalogue root", () => {
    const projectRoot = createLocaleFixture(`
const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;

const { de: { live } } = catalog;
export const readLive = (): string => live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([
      { catalog: "src/dashboard/locale.ts#catalog", key: "orphan" },
    ]);
  });

  it("does not report a translated key accessed through a root-destructured language", () => {
    const projectRoot = createLocaleFixture(`
const catalog = {
  de: { live: "Verwendet", orphan: "Ungenutzt" },
  en: { live: "Used", orphan: "Unused" },
} as const;

const { de } = catalog;
export const readLive = (): string => de.live;
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });

  it("keeps the conservative fallback for a bracket read of mixed text and group members", () => {
    const projectRoot = createLocaleFixture(`
const catalog = {
  de: { label: "Titel", nested: { live: "Verwendet" } },
  en: { label: "Title", nested: { live: "Used" } },
};
export const read = (key: "label" | "nested"): string => {
  const value = catalog.en[key];
  return typeof value === "string" ? value : value.live;
};
`);

    expect(unusedLocaleKeys(projectRoot)).toEqual([]);
  });
});
