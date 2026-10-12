import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

const listTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [entryPath] : [];
  }));
  return nestedFiles.flat();
};

describe("dashboard UI color tokens", () => {
  it("keeps fixed colors in the token stylesheet", async () => {
    const uiDirectory = join(process.cwd(), "src/dashboard/ui");
    const files = await listTypeScriptFiles(uiDirectory);
    const colorPattern = /#(?:[\da-f]{3,8})\b|\brgba?\s*\(|\bhsla?\s*\(/i;
    const violations = (await Promise.all(files.map(async (file) => ({
      file,
      contents: await readFile(file, "utf8"),
    })))).flatMap(({ file, contents }) => {
      const source = contents.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      const matches = source.split("\n").flatMap((line, index) => colorPattern.test(line)
        ? [{ file, line: index + 1, source: line.trim() }]
        : []);
      return matches;
    });

    expect(violations).toEqual([]);
  });
});
