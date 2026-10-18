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
import {
  overlayAccessColumns,
  overlayAccessActivePredicate,
  overlayAccessMetadataColumns,
} from "../../src/worker/auth/overlay-access-repository";
import { overlayElementIdCollisionGuard, referencedVariablesGuard } from "../../src/worker/db/overlays";
import { platformRolesSql } from "../../src/worker/platform/repository";
import { channelStateQuery } from "../../src/worker/panel/repository";
import { apiSourceReferenceQuery } from "../../src/modules/api_source/routes";
import { CLAIM_ELIGIBLE_SQL, textCommandSelectColumns } from "../../src/modules/text_commands/adapters/d1";
import { FAQ_CLAIM_ELIGIBLE_SQL } from "../../src/modules/faq/adapters/d1";
import { votekickAdmissionReasonSql } from "../../src/modules/votekick/adapters/d1";
import { blockUsageExistsSql, textBlockCategorySelectColumns, textBlockSelectColumns } from "../../src/modules/text_library/adapters/d1";
import { chatVoteSelectColumns, chatVoteTemplateSelectColumns } from "../../src/modules/chat_voting/repository";
import {
  belaboxExpectedOpenStreamSetGuard,
  belaboxHistoryModuleRevisionGuard,
  belaboxHistoryStatusGuard,
  belaboxStreamStateSnapshotGuard,
  belaboxStreamSessionGuard,
} from "../../src/modules/belabox/adapters/d1";
import { MANAGING_ROLES } from "../../src/contracts/values";
import {
  CHAT_VOTE_RESULT_TEXT_REFERENCE_CURRENT_VOTE_WHERE_SQL,
  CHAT_VOTE_RESULT_TEXT_REFERENCE_DEFAULT_UPDATED_AT_SQL,
  CHAT_VOTE_RESULT_TEXT_REFERENCE_EXISTS_SQL,
  CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL,
  CHAT_VOTE_RESULT_TEXT_REFERENCE_TOKEN_PREDICATE_SQL,
} from "../../src/modules/contracts/chat-vote-result-text-references";
import { textBlockWriteGuard } from "../../src/modules/contracts/text-block-write-guard";
import { columnVariableReferences, moduleVariableRenameTarget } from "../../src/modules/contract";
import { textLibraryModule } from "../../src/modules/text_library";
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
const emptyReferenceDatabase = {
  prepare: () => ({ bind: () => ({ all: () => Promise.resolve({ results: [] }) }) }),
} as unknown as D1Database;
const faqRenameValidation = await columnVariableReferences({
  moduleId: "faq",
  tableName: "faq_entries",
  idColumn: "faq_id",
  itemNameColumn: "name",
  textColumn: "answer_text",
}).validateRename?.(emptyReferenceDatabase, "channel-id", "score", "points");
const timerRenameValidation = await columnVariableReferences({
  moduleId: "timers",
  tableName: "timers",
  idColumn: "timer_id",
  itemNameColumn: "name",
  textColumn: "message_text",
}).validateRename?.(emptyReferenceDatabase, "channel-id", "score", "points");
const textLibraryRenameValidation = await textLibraryModule.variableReferences?.validateRename?.(
  emptyReferenceDatabase,
  "channel-id",
  "score",
  "points",
);
const actor = { userId: "actor-user", sessionId: "actor-session" };
const baselineModulePath = "../../scripts/d1-baseline.mjs";
const { generateBaseline } = await import(baselineModulePath) as unknown as {
  generateBaseline: () => string;
};

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fileName);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.startsWith("__eslint_probe_") ? [fileName] : [];
  })
  .sort((a, b) => a.localeCompare(b));

// Every gap is filled with the **real** production fragment, not a
// stand-in. A stand-in would take exactly the query from the check it
// replaces -- for `channelStateQuery` that would be the project's largest query.
// Only `placeholders` is built at runtime and has no production literal.
const sqlGetFixtures = new Map<string, string>([
  ["authorization.sql", authorizeModuleMutation("channel-id", actor, now).sql],
  ["referenceQuery.sql", apiSourceReferenceQuery("channel-id", "sunset").sql],
  ["CHAT_VOTE_RESULT_TEXT_REFERENCE_EXISTS_SQL", CHAT_VOTE_RESULT_TEXT_REFERENCE_EXISTS_SQL],
  ["CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL", CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL],
  ["CHAT_VOTE_RESULT_TEXT_REFERENCE_CURRENT_VOTE_WHERE_SQL", CHAT_VOTE_RESULT_TEXT_REFERENCE_CURRENT_VOTE_WHERE_SQL],
  ["CHAT_VOTE_RESULT_TEXT_REFERENCE_TOKEN_PREDICATE_SQL", CHAT_VOTE_RESULT_TEXT_REFERENCE_TOKEN_PREDICATE_SQL],
  ["CHAT_VOTE_RESULT_TEXT_REFERENCE_DEFAULT_UPDATED_AT_SQL", CHAT_VOTE_RESULT_TEXT_REFERENCE_DEFAULT_UPDATED_AT_SQL],
  ["tokenPredicate", CHAT_VOTE_RESULT_TEXT_REFERENCE_TOKEN_PREDICATE_SQL],
  ["updatedAtSql", CHAT_VOTE_RESULT_TEXT_REFERENCE_DEFAULT_UPDATED_AT_SQL],
  ["conditionSql", "1 = 1"],
  ["sessionGuard.sql", belaboxStreamSessionGuard("channel-id", {
    state: "online",
    changedAt: now,
    startedAt: now,
    streamId: "stream-id",
  }).sql],
  ["minimumValue", "-999999999"],
  ["maximumValue", "999999999"],
  ["MINIMUM_VALUE_SQL", "-999999999"],
  ["MAXIMUM_VALUE_SQL", "999999999"],
  ["prepareModuleAudit === undefined ? \"\" : \"AND changes() > 0\"", "AND changes() > 0"],
  ["variableChange === null ? \"\" : \"AND changes() > 0\"", "AND changes() > 0"],
  ["requirePreviousChange ? \"AND changes() > 0\" : \"\"", "AND changes() > 0"],
  ["actorGuard(overlayTokenRoles)", actorGuard(overlayTokenRoles)],
  ["overlayTokenSelectColumns", overlayTokenSelectColumns],
  ["overlayTokenReturningColumns", overlayTokenReturningColumns],
  ["overlayAccessColumns", overlayAccessColumns],
  ["overlayAccessActivePredicate", overlayAccessActivePredicate],
  ["overlayAccessMetadataColumns", overlayAccessMetadataColumns],
  ["guardParts.sql", platformSessionGuard(actor, now).sql],
  ["lastBroadcasterRoleChangeGuard", lastBroadcasterRoleChangeGuard],
  ["lastBroadcasterGuard", lastBroadcasterGuard],
  ["actorGuard(MANAGING_ROLES)", actorGuard(MANAGING_ROLES)],
  ["actorGuard(ANY_MEMBER_ROLES)", actorGuard(ANY_MEMBER_ROLES)],
  ["addedIdGuard", overlayElementIdCollisionGuard(1)],
  ["referencedVariablesGuard", referencedVariablesGuard],
  ["sqlRole(\"broadcaster\")", sqlRole("broadcaster")],
  ["sqlRole(\"manager\")", sqlRole("manager")],
  ["sqlRole(\"operator\")", sqlRole("operator")],
  ["guard.sql", platformSessionGuard(actor, now).sql],
  ["settingsExpression", "replace(settings, ?, ?)"],
  ["moduleId === null ? \"\" : \"AND module_id = ?\"", "AND module_id = ?"],
  ["whereSql", "AND enabled = 1"],
  ["platformRolesSql", platformRolesSql],
  ["placeholders", "?, ?, ?"],
  ["channelStateQuery", channelStateQuery],
  ["textCommandSelectColumns", textCommandSelectColumns],
  ["CLAIM_ELIGIBLE_SQL", CLAIM_ELIGIBLE_SQL],
  ["FAQ_CLAIM_ELIGIBLE_SQL", FAQ_CLAIM_ELIGIBLE_SQL],
  ["quotedIdColumn", '"faq_id"'],
  ["quotedItemNameColumn", '"name"'],
  ["quotedTableName", '"faq_entries"'],
  ["quotedTextColumn", '"answer_text"'],
  ["columnUpdates.join(\", \")", '"answer_text" = replace("answer_text", ?, ?), "revision" = "revision" + 1, "updated_at" = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')'],
  ["renamePreconditionSql", [faqRenameValidation, timerRenameValidation, textLibraryRenameValidation]
    .flatMap((validation) => validation === undefined ? [] : [`AND (${validation.precondition.sql})`]).join("\n") || ""],
  ["target.sql", moduleVariableRenameTarget("channel-id", "points", {
    value: 0,
    description: "",
    resetOnStreamStart: false,
    createdAt: now,
    updatedAt: now,
  }).sql],
  ["rowColumns", "votekick_id, target_user_id, target_login, initiator_user_id, status, threshold, yes_votes, no_votes, ballot_revision, duration_seconds, started_at, expires_at, ended_at, lifted_at"],
  ["votekickAdmissionReasonSql(\"admitted\")", votekickAdmissionReasonSql("admitted")],
  ["votekickAdmissionReasonSql(\"busy\")", votekickAdmissionReasonSql("busy")],
  ["selectFaqEntries", `SELECT faq.faq_id, faq.name, faq.enabled, faq.matcher_type, faq.matcher_json, faq.answer_text, faq.cooldown_seconds,
                                 faq.games_json, faq.chat_target, entry_order.sort_order, faq.revision, faq.last_used_at, faq.created_at, faq.updated_at
                            FROM faq_entries AS faq
                            JOIN faq_entry_order AS entry_order ON entry_order.channel_id = faq.channel_id AND entry_order.faq_id = faq.faq_id
                           WHERE faq.channel_id = ?`],
  ["textBlockSelectColumns", textBlockSelectColumns],
  ["textBlockCategorySelectColumns", textBlockCategorySelectColumns],
  ["blockUsageExistsSql", blockUsageExistsSql],
  ["chatVoteSelectColumns", chatVoteSelectColumns],
  ["chatVoteTemplateSelectColumns", chatVoteTemplateSelectColumns],
  ["belaboxHistoryStatusGuard", belaboxHistoryStatusGuard],
  ["belaboxHistoryModuleRevisionGuard", belaboxHistoryModuleRevisionGuard],
  ["belaboxStreamStateSnapshotGuard", belaboxStreamStateSnapshotGuard],
  ["expectedOpenStreamSetGuard.sql", belaboxExpectedOpenStreamSetGuard("channel-id", null, []).sql],
  ["assignments.join(\",\\n            \")", "polling = 0, history_sample_json = NULL, history_module_revision = NULL, revision = revision + 1"],
  ["changes.join(\" OR \")", "polling != 0 OR history_sample_json IS NOT NULL OR history_module_revision IS NOT NULL"],
  ["guard", authorizeModuleMutation("channel-id", actor, now).sql],
  ["channelBotConsentCondition(\"channel\")", channelBotConsentCondition("channel")],
  ["authorization.sql", authorizeModuleMutation("channel-id", actor, now).sql],
  ["predicateSql", "1 = 1"],
  ["blockGuard.sql", textBlockWriteGuard("channel-id", 1, ["{text.welcome}"]).sql],
  ["textBlockGuard?.sql ?? \"\"", textBlockWriteGuard("channel-id", 1, ["{text.welcome}"]).sql],
  ["renamedBlockGuard", `EXISTS (
        SELECT 1 FROM text_blocks
         WHERE channel_id = ? AND block_name = ? AND revision = ?
      )`],
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
      expect(objects.filter((object) => object.type === "table")).toHaveLength(64);
      expect(objects.filter((object) => object.type === "index")).toHaveLength(51);
      expect(objects.filter((object) => object.type === "trigger")).toHaveLength(132);
      expect(objects).toHaveLength(247);

      const tableColumns = (table: string): Set<string> => new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name),
      );
      expect([...tableColumns("channel_controls")]).toEqual(expect.arrayContaining([
        "mute_stream_started_at", "pause_stream_started_at",
      ]));
      expect([...tableColumns("channel_stream_state")]).toEqual(expect.arrayContaining([
        "checked_at", "eventsub_changed_at",
      ]));
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
