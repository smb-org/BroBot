import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * SQL is only allowed to see a role through `sqlRole`/`sqlRoleList`
 * (`src/worker/db/guards.ts`) -- a raw `'broadcaster'`-style literal
 * anywhere else under `src/worker/` is exactly the bug this migration
 * fixed (role text drifting from `CHANNEL_ROLES`). This scans the actual
 * TypeScript string/template literal nodes, not the raw text, so a
 * mention of a role in a comment or JSDoc code span doesn't trip it --
 * only what the compiler would treat as a literal in the emitted code.
 */
const workerRoot = path.resolve(import.meta.dirname, "../../src/worker");

const rolePattern = /'(broadcaster|manager|operator)'/;

interface Hit {
  fileName: string;
  line: number;
  text: string;
}

const filesUnder = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  })
  .sort();

const isRoleLiteralCandidate = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);

const scanFile = (filePath: string): Hit[] => {
  const source = readFileSync(filePath, "utf8");
  const fileName = path.relative(path.resolve(import.meta.dirname, "../.."), filePath).replaceAll(path.sep, "/");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    if (isRoleLiteralCandidate(node)) {
      const text = node.getText(sourceFile);
      if (rolePattern.test(text)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        hits.push({ fileName, line, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
};

describe("role SQL guard", () => {
  it("finds no raw quoted role literal anywhere under src/worker", () => {
    const files = filesUnder(workerRoot);
    // Without this floor, the test would pass if the scan no longer walked
    // any files -- for example because the root path changed silently.
    expect(files.length).toBeGreaterThan(20);
    const hits = files.flatMap(scanFile);
    expect(hits).toEqual([]);
  });
});
