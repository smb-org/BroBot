import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TestD1Result {
  results: unknown[];
  success: true;
  meta: { changes: number; last_row_id?: number; size?: number };
}

export class TestPreparedStatement {
  private values: SQLInputValue[] = [];

  public constructor(private readonly statement: ReturnType<DatabaseSync["prepare"]>) {}

  public bind(...values: SQLInputValue[]): this {
    this.values = values;
    return this;
  }

  public runSync(): TestD1Result {
    const result = this.statement.run(...this.values);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
        size: 0,
      },
    };
  }

  public run(): Promise<TestD1Result> {
    return Promise.resolve().then(() => this.runSync());
  }

  public first<T>(): Promise<T | null> {
    return Promise.resolve((this.statement.get(...this.values) as T | undefined) ?? null);
  }

  public all<T>(..._typeHint: readonly T[]): Promise<{ results: T[]; success: true; meta: { changes: number; size: number } }> {
    void _typeHint;
    const results = this.statement.all(...this.values) as T[];
    return Promise.resolve({
      results,
      success: true,
      meta: { changes: 0, size: 0 },
    });
  }
}

export class TestD1Database {
  public readonly sqlite = new DatabaseSync(":memory:");

  public constructor(migrationCount = 3) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const migrationNames = [
      "0000_init.sql",
      "0001_twitch_login.sql",
      "0002_autorisierung.sql",
    ];
    for (const migrationName of migrationNames.slice(0, migrationCount)) {
      this.sqlite.exec(readFileSync(resolve(import.meta.dirname, `../../migrations/${migrationName}`), "utf8"));
    }
  }

  public prepare(sql: string): TestPreparedStatement {
    return new TestPreparedStatement(this.sqlite.prepare(sql));
  }

  public batch(statements: TestPreparedStatement[]): Promise<TestD1Result[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public close(): void {
    this.sqlite.close();
  }
}
