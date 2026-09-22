import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Die Diagnose-Details sind `Record<string, unknown>` — sie haben keine
 * Typdeklaration, deren Schlüssel man einfrieren könnte. Genau deshalb sind
 * hier dreimal unbemerkt deutsche Schlüssel liegengeblieben, obwohl sie in
 * `event_log.detail_json` landen und die Oberfläche sie ausliest.
 *
 * Dieser Test sammelt sie aus dem Quelltext ein. Ein neuer Schlüssel muss hier
 * eingetragen werden — und wer ihn einträgt, sieht die englischen Nachbarn.
 */
const moduleSources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return moduleSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

const detailKeys = (): string[] => {
  const found = new Set<string>();
  for (const file of moduleSources(resolve(import.meta.dirname, "../../src/modules")).sort()) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      const isDetail = (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "detail")
        || (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "detail");
      if (isDetail) {
        const argumentNode = ts.isCallExpression(node) ? node.arguments[0] : node.initializer;
        if (argumentNode !== undefined && ts.isObjectLiteralExpression(argumentNode)) {
          for (const property of argumentNode.properties) {
            const name = ts.isShorthandPropertyAssignment(property)
              ? property.name.text
              : property.name !== undefined && ts.isIdentifier(property.name)
                ? property.name.text
                : null;
            if (name !== null) found.add(name);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found].sort();
};

describe("Diagnose-Detailschlüssel", () => {
  it("friert die Schlüsselmenge ein, die auf der Leitung landet", () => {
    expect(detailKeys()).toEqual([
      "action", "count", "currentTier", "duration", "endsAt", "gifter", "kind",
      "message", "moderator", "name", "person", "reason", "recipient",
      "remainingSeconds", "requiredTier", "response", "scope", "source",
      "sourceChannelId", "status", "target", "targetChannelId", "text",
      "threshold", "tier", "viewers",
    ]);
  });

  it("lässt keinen deutschen Schlüssel durch", () => {
    const suspicious = detailKeys().filter((name) => /[äöüÄÖÜß]|^(stufe|quelle|dauer|aktion|schwelle|ziel|spender|antwort|ende|empfaenger|restSekunden|anzahl|grund|zuschauer)$/.test(name));
    expect(suspicious).toEqual([]);
  });
});
