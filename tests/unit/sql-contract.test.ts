import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import {
  actorGuard,
  betreiberSessionGuard,
  channelBotConsentCondition,
  lastBroadcasterGuard,
  lastBroadcasterRoleChangeGuard,
} from "../../src/worker/auth/repository";
import {
  overlayTokenReturningColumns,
  overlayTokenRoles,
  overlayTokenSelectColumns,
} from "../../src/worker/auth/overlay-token-repository";
import { betreiberRollenSql } from "../../src/worker/betreiber/repository";
import { channelStateQuery } from "../../src/worker/panel/repository";

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

interface SqlContractQuery {
  fileName: string;
  line: number;
  sql: string;
}

const sourceDirectory = path.resolve(import.meta.dirname, "../../src");
const now = "2026-01-01T00:00:00.000Z";
const actor = { userId: "actor-user", sessionId: "actor-session" };
const baselineModulePath = "../../scripts/d1-baseline.mjs";
const { generateBaseline } = await import(baselineModulePath) as unknown as {
  generateBaseline: () => string;
};

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fileName);
    return /\.(ts|tsx)$/.test(entry.name) ? [fileName] : [];
  })
  .sort();

// Jede Luecke wird mit dem **echten** Produktionsfragment gefuellt, nicht mit einer
// Attrappe. Eine Attrappe wuerde genau die Abfrage aus der Pruefung nehmen, die sie
// ersetzt -- bei `channelStateQuery` waere das die groesste Abfrage des Projekts.
// Nur `placeholders` ist zur Laufzeit gebildet und hat kein Produktionsliteral.
const sqlHoleFixtures = new Map<string, string>([
  ["authorization.sql", authorizeModuleMutation("channel-id", actor, now).sql],
  ["prepareModuleAudit === undefined ? \"\" : \"AND changes() > 0\"", "AND changes() > 0"],
  ["actorGuard(overlayTokenRoles)", actorGuard(overlayTokenRoles)],
  ["overlayTokenSelectColumns", overlayTokenSelectColumns],
  ["overlayTokenReturningColumns", overlayTokenReturningColumns],
  ["guardParts.sql", betreiberSessionGuard(actor, now).sql],
  ["lastBroadcasterRoleChangeGuard", lastBroadcasterRoleChangeGuard],
  ["lastBroadcasterGuard", lastBroadcasterGuard],
  ["actorGuard(\"'broadcaster', 'verwalter'\")", actorGuard("'broadcaster', 'verwalter'")],
  ["schutz.sql", betreiberSessionGuard(actor, now).sql],
  ["betreiberRollenSql", betreiberRollenSql],
  ["placeholders", "?, ?, ?"],
  ["channelStateQuery", channelStateQuery],
  ["channelBotConsentCondition(\"channel\")", channelBotConsentCondition("channel")],
]);

// Wrangler führt diese Tabelle selbst und legt sie nicht über unsere Migrationen an.
const schemaExceptions = [
  { fileName: "src/worker/config.ts", tableName: "d1_migrations" },
] as const;

const isSqlLiteral = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);

const replaceSqlHoles = (literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression, fileName: string, sourceFile: ts.SourceFile): string => {
  if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) return literal.text;
  let sql = literal.head.text;
  for (const span of literal.templateSpans) {
    const expression = span.expression.getText(sourceFile);
    const replacement = sqlHoleFixtures.get(expression);
    if (replacement === undefined) {
      const line = sourceFile.getLineAndCharacterOfPosition(span.expression.getStart(sourceFile)).line + 1;
      throw new Error("Unbekannte SQL-Lücke in " + fileName + ":" + String(line) + ": " + expression);
    }
    sql += replacement + span.literal.text;
  }
  return sql;
};

const collectPreparedQueries = (): SqlContractQuery[] => sourceFiles(sourceDirectory).flatMap((filePath) => {
  const source = readFileSync(filePath, "utf8");
  const fileName = path.relative(path.resolve(import.meta.dirname, "../.."), filePath).replaceAll(path.sep, "/");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const queries: SqlContractQuery[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prepare") {
      const argument = node.arguments[0];
      if (argument !== undefined && isSqlLiteral(argument)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        queries.push({ fileName, line, sql: replaceSqlHoles(argument, fileName, sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return queries;
});

const prepareBaseline = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec(generateBaseline());
  return database;
};

const hasSchemaException = (query: SqlContractQuery): boolean => schemaExceptions.some((exception) =>
  exception.fileName === query.fileName && query.sql.includes(exception.tableName));

describe("SQL-Vertrag", () => {
  it("erzeugt die erwartete Baseline aus allen Migrationen", () => {
    const database = prepareBaseline();
    try {
      const objects = database.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY tbl_name, type DESC, name",
      ).all() as unknown as SchemaObject[];
      expect(objects.filter((object) => object.type === "table")).toHaveLength(19);
      expect(objects.filter((object) => object.type === "index")).toHaveLength(23);
      expect(objects).toHaveLength(42);
    } finally {
      database.close();
    }
  });

  it("bereitet jede bekannte SQL-Abfrage gegen die Baseline vor", () => {
    const database = prepareBaseline();
    try {
      const queries = collectPreparedQueries();
      // Ohne diese Schranke waere der Test gruen, wenn der AST-Lauf nichts mehr
      // findet -- etwa weil sich der Aufrufname aendert. Er pruefte dann nichts.
      expect(queries.length).toBeGreaterThanOrEqual(100);
      for (const query of queries) {
        if (hasSchemaException(query)) continue;
        try {
          database.prepare(query.sql);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error("SQL-Vertrag verletzt in " + query.fileName + ":" + String(query.line) + ": " + message, { cause: error });
        }
      }
    } finally {
      database.close();
    }
  });
});
