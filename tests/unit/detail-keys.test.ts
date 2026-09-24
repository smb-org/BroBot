import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Diagnostic details are `Record<string, unknown>` — they have no type
 * declaration whose keys could be frozen. That's exactly why German keys
 * have slipped through unnoticed three times here, even though they land in
 * `event_log.detail_json` and the UI reads them out.
 *
 * This test collects them from the source. A new key has to be entered
 * here — and whoever enters it sees its English neighbors.
 */
const moduleSources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return moduleSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

const detailKeys = (): string[] => {
  const found = new Set<string>();
  const collectObjectKeys = (value: ts.Expression): void => {
    if (ts.isConditionalExpression(value)) {
      collectObjectKeys(value.whenTrue);
      collectObjectKeys(value.whenFalse);
      return;
    }
    if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)) {
      collectObjectKeys(value.expression);
      return;
    }
    if (!ts.isObjectLiteralExpression(value)) return;
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        collectObjectKeys(property.expression);
        continue;
      }
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : ts.isIdentifier(property.name)
          ? property.name.text
          : null;
      if (name !== null) found.add(name);
    }
  };
  for (const file of moduleSources(resolve(import.meta.dirname, "../../src/modules")).sort()) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      const isDetail = (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "detail")
        || (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "detail")
        || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "rejection");
      if (isDetail) {
        const argumentNode = ts.isCallExpression(node)
          ? ts.isIdentifier(node.expression) && node.expression.text === "rejection" ? node.arguments[1] : node.arguments[0]
          : node.initializer;
        if (argumentNode !== undefined) collectObjectKeys(argumentNode);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found].sort();
};

describe("diagnostic detail keys", () => {
  it("freezes the set of keys that land on the wire", () => {
    expect(detailKeys()).toEqual([
      "action", "alias", "allowed", "arguments", "art", "count", "current", "currentTier", "duration", "endsAt", "gifter",
      "message", "moderator", "name", "person", "reason", "recipient",
      "remainingSeconds", "requiredTier", "response", "scope", "source",
      "sourceChannelId", "startedAt", "status", "streamState", "target", "targetChannelId", "text",
      "threshold", "tier", "variable", "viewers",
    ]);
  });

  it("lets no German key through", () => {
    const suspicious = detailKeys().filter((name) => /[äöüÄÖÜß]|^(stufe|quelle|dauer|aktion|schwelle|ziel|spender|antwort|ende|empfaenger|restSekunden|anzahl|grund|zuschauer)$/.test(name));
    expect(suspicious).toEqual([]);
  });
});
