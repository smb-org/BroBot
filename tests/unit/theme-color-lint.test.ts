import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const listUiSourceFiles = async (directory: string, rootDirectory = directory): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return listUiSourceFiles(entryPath, rootDirectory);
    const isUiSource = [".ts", ".tsx", ".css"].includes(extname(entry.name));
    const isTokenStylesheet = resolve(entryPath) === resolve(rootDirectory, "tokens.css");
    return isUiSource && !isTokenStylesheet ? [entryPath] : [];
  }));
  return nestedFiles.flat();
};

const findColorViolations = async (uiDirectory: string): Promise<Array<{ file: string; line: number; source: string }>> => {
  const files = await listUiSourceFiles(uiDirectory);
  const colorPattern = /#(?:[\da-f]{3,8})\b|\brgba?\s*\(|\bhsla?\s*\(/i;
  return (await Promise.all(files.map(async (file) => ({
      file,
      contents: await readFile(file, "utf8"),
    })))).flatMap(({ file, contents }) => {
      const source = contents.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      const matches = source.split("\n").flatMap((line, index) => colorPattern.test(line)
        ? [{ file, line: index + 1, source: line.trim() }]
        : []);
      return matches;
    });
};

describe("dashboard UI color tokens", () => {
  it("keeps fixed colors in the token stylesheet", async () => {
    const uiDirectory = join(process.cwd(), "src/dashboard/ui");
    const violations = await findColorViolations(uiDirectory);
    expect(violations).toEqual([]);
  });

  it("rejects fixed colors in CSS while excluding only the root token stylesheet", async () => {
    const uiDirectory = await mkdtemp(join(tmpdir(), "theme-color-lint-"));
    try {
      await mkdir(join(uiDirectory, "nested"));
      await writeFile(join(uiDirectory, "tokens.css"), ".token { color: #123456; }\n");
      await writeFile(join(uiDirectory, "nested", "component.css"), ".component { color: #123456; }\n");

      await expect(findColorViolations(uiDirectory)).resolves.toEqual([
        { file: join(uiDirectory, "nested", "component.css"), line: 1, source: ".component { color: #123456; }" },
      ]);
    } finally {
      await rm(uiDirectory, { recursive: true, force: true });
    }
  });
});
