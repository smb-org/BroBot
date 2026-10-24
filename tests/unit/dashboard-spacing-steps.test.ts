import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

// tokens.css defines --spacing-N for a few steps only, and Tailwind's base --spacing is 0.25rem
// (3.5px on the 14px root). A utility with any other step (gap-1.5, px-2.5, min-h-16) therefore
// renders off the 4px grid. Use a defined step or an arbitrary value such as px-[10px].
const spacingUtilities = [
  "w", "h", "size", "min-w", "min-h", "max-w", "max-h",
  "p", "px", "py", "pt", "pr", "pb", "pl", "ps", "pe",
  "m", "mx", "my", "mt", "mr", "mb", "ml", "ms", "me",
  "gap", "gap-x", "gap-y", "inset", "inset-x", "inset-y", "top", "right", "bottom", "left", "start", "end",
  "translate-x", "translate-y", "space-x", "space-y",
].join("|");
// A step is the number directly after the utility; "/", "-", "[" or letters after it make it another utility.
const utilityPattern = new RegExp(`(?<![\\w-])-?(?:${spacingUtilities})-(\\d+(?:\\.\\d+)?)(?![\\w./\\[-])`, "g");

const listSourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
};

const findUndefinedSteps = async (sourceDirectory: string, definedSteps: ReadonlySet<string>) => {
  const files = await listSourceFiles(sourceDirectory);
  const found = await Promise.all(files.map(async (file) => {
    const lines = (await readFile(file, "utf8")).split("\n");
    return lines.flatMap((line, index) => [...line.matchAll(utilityPattern)]
      .filter((match) => match[1] !== "0" && !definedSteps.has(match[1] ?? ""))
      .map((match) => `${file.slice(process.cwd().length + 1)}:${String(index + 1)} ${match[0]}`));
  }));
  return found.flat();
};

describe("dashboard spacing utilities", () => {
  it("only use steps defined in tokens.css", async () => {
    const tokens = await readFile(join(process.cwd(), "src/dashboard/ui/tokens.css"), "utf8");
    const definedSteps = new Set([...tokens.matchAll(/--spacing-(\d+(?:\.\d+)?):/g)].map((match) => match[1] ?? ""));
    expect(definedSteps.size).toBeGreaterThan(0);
    expect(await findUndefinedSteps(join(process.cwd(), "src"), definedSteps)).toEqual([]);
  });

  it("detects steps that tokens.css does not define", () => {
    expect([..."gap-1.5 px-2.5 min-h-16 md:-mt-9 w-1/2 gap-4 p-0 size-[10px]".matchAll(utilityPattern)].map((match) => match[1])).toEqual(["1.5", "2.5", "16", "9", "4", "0"]);
  });
});
