import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import {
  actorGuard,
  platformSessionGuard,
  channelBotConsentCondition,
  lastBroadcasterGuard,
  lastBroadcasterRoleChangeGuard,
  sqlRole,
} from "../../src/worker/db/guards";
import {
  overlayTokenReturningColumns,
  overlayTokenRoles,
  overlayTokenSelectColumns,
} from "../../src/worker/auth/overlay-token-repository";
import { platformRolesSql } from "../../src/worker/platform/repository";
import { channelStateQuery } from "../../src/worker/panel/repository";
import { textCommandSelectColumns } from "../../src/modules/text_commands/adapters/d1";
import { MANAGING_ROLES } from "../../src/contracts/values";
import { ANY_MEMBER_ROLES } from "../../src/worker/db/guards";

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

// Every gap is filled with the **real** production fragment, not a
// stand-in. A stand-in would take exactly the query from the check it
// replaces -- for `channelStateQuery` that would be the project's largest query.
// Only `placeholders` is built at runtime and has no production literal.
const sqlGetFixtures = new Map<string, string>([
  ["authorization.sql", authorizeModuleMutation("channel-id", actor, now).sql],
  ["minimumValue", "-999999999"],
  ["maximumValue", "999999999"],
  ["MINIMUM_VALUE_SQL", "-999999999"],
  ["MAXIMUM_VALUE_SQL", "999999999"],
  ["prepareModuleAudit === undefined ? \"\" : \"AND changes() > 0\"", "AND changes() > 0"],
  ["actorGuard(overlayTokenRoles)", actorGuard(overlayTokenRoles)],
  ["overlayTokenSelectColumns", overlayTokenSelectColumns],
  ["overlayTokenReturningColumns", overlayTokenReturningColumns],
  ["guardParts.sql", platformSessionGuard(actor, now).sql],
  ["lastBroadcasterRoleChangeGuard", lastBroadcasterRoleChangeGuard],
  ["lastBroadcasterGuard", lastBroadcasterGuard],
  ["actorGuard(MANAGING_ROLES)", actorGuard(MANAGING_ROLES)],
  ["actorGuard(ANY_MEMBER_ROLES)", actorGuard(ANY_MEMBER_ROLES)],
  ["sqlRole(\"broadcaster\")", sqlRole("broadcaster")],
  ["sqlRole(\"manager\")", sqlRole("manager")],
  ["sqlRole(\"operator\")", sqlRole("operator")],
  ["guard.sql", platformSessionGuard(actor, now).sql],
  ["platformRolesSql", platformRolesSql],
  ["placeholders", "?, ?, ?"],
  ["channelStateQuery", channelStateQuery],
  ["textCommandSelectColumns", textCommandSelectColumns],
  ["channelBotConsentCondition(\"channel\")", channelBotConsentCondition("channel")],
]);

// Wrangler manages this table itself and doesn't create it via our migrations.
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
    const replacement = sqlGetFixtures.get(expression);
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

describe("SQL contract", () => {
  it("produces the expected baseline from all migrations", () => {
    const database = prepareBaseline();
    try {
      const objects = database.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY tbl_name, type DESC, name",
      ).all() as unknown as SchemaObject[];
      expect(objects.filter((object) => object.type === "table")).toHaveLength(25);
      expect(objects.filter((object) => object.type === "index")).toHaveLength(26);
      expect(objects).toHaveLength(51);
    } finally {
      database.close();
    }
  });

  it("prepares every known SQL query against the baseline", () => {
    const database = prepareBaseline();
    try {
      const queries = collectPreparedQueries();
      // Without this floor, the test would pass if the AST run no longer
      // finds anything -- for example because the call name changes. It would then test nothing.
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

  it("supports json_each and the WITHOUT ROWID cooldown table in its SQLite harness", () => {
    const database = prepareBaseline();
    try {
      expect(database.prepare("SELECT value FROM json_each('[\"alias\"]')").get()).toEqual({ value: "alias" });
      const cooldownTable = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'text_command_user_cooldowns'",
      ).get() as { sql: string } | undefined;
      expect(cooldownTable?.sql).toMatch(/WITHOUT ROWID/i);
    } finally {
      database.close();
    }
  });
});
