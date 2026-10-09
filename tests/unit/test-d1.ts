import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const positionalBindingCount = (sql: string): number => {
  let count = 0;
  let index = 0;
  let quote: string | null = null;
  while (index < sql.length) {
    const character = sql[index];
    if (quote !== null) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = null;
      }
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const commentEnd = sql.indexOf("*/", index + 2);
      index = commentEnd === -1 ? sql.length : commentEnd + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "[") {
      quote = "]";
    } else if (character === "?") {
      count += 1;
    }
    index += 1;
  }
  return count;
};

// rows_written is synthetic here: DML mirrors SQLite changes and does not measure D1 write amplification.
export interface TestD1Result {
  results: unknown[];
  success: true;
  meta: { changes: number; rows_written: number; last_row_id?: number; size?: number };
}

export class TestPreparedStatement {
  private values: SQLInputValue[] = [];

  public constructor(
    private readonly database: DatabaseSync,
    private readonly statement: ReturnType<DatabaseSync["prepare"]>,
    private readonly sql: string,
  ) {}

  public bind(...values: SQLInputValue[]): this {
    this.assertBindingCount(values.length);
    this.values = values;
    return this;
  }

  private assertBindingCount(actual: number): void {
    const expected = positionalBindingCount(this.sql);
    if (actual !== expected) {
      throw new Error(`SQLite test adapter expected ${String(expected)} bind values but received ${String(actual)}.`);
    }
  }

  public runSync(): TestD1Result {
    this.assertBindingCount(this.values.length);
    if (/^\s*SELECT\b/iu.test(this.sql)) {
      const results = this.statement.all(...this.values) as unknown[];
      const metadata = this.database.prepare("SELECT changes() AS changes, last_insert_rowid() AS last_row_id").get() as {
        changes: number;
        last_row_id: number;
      };
      return {
        results,
        success: true,
        meta: { changes: metadata.changes, rows_written: 0, last_row_id: metadata.last_row_id, size: 0 },
      };
    }
    if (/\bRETURNING\b/iu.test(this.sql)) {
      const results = this.statement.all(...this.values) as unknown[];
      const metadata = this.database.prepare("SELECT changes() AS changes, last_insert_rowid() AS last_row_id").get() as {
        changes: number;
        last_row_id: number;
      };
      return {
        results,
        success: true,
        meta: { changes: metadata.changes, rows_written: metadata.changes, last_row_id: metadata.last_row_id, size: 0 },
      };
    }
    const result = this.statement.run(...this.values);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes),
        rows_written: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
        size: 0,
      },
    };
  }

  public run(): Promise<TestD1Result> {
    return Promise.resolve().then(() => this.runSync());
  }

  public first<T>(): Promise<T | null> {
    this.assertBindingCount(this.values.length);
    return Promise.resolve((this.statement.get(...this.values) as T | undefined) ?? null);
  }

  public all<T>(..._typeHint: readonly T[]): Promise<{ results: T[]; success: true; meta: { changes: number; size: number } }> {
    this.assertBindingCount(this.values.length);
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

  public constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    // Files are read rather than enumerated: a name list in the test
    // eventually falls behind the directory, and that only surfaces
    // when a migration silently fails to run.
    const verzeichnis = resolve(import.meta.dirname, "../../migrations");
    for (const datei of readdirSync(verzeichnis).filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b))) {
      this.sqlite.exec(readFileSync(resolve(verzeichnis, datei), "utf8"));
    }
  }

  public prepare(sql: string): TestPreparedStatement {
    return new TestPreparedStatement(this.sqlite, this.sqlite.prepare(sql), sql);
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

/** Holds selected D1 reads until all expected independent reads have started. */
export const createReadBarrierDatabase = (
  database: TestD1Database,
  identify: (sql: string, operation: "first" | "all") => string | null,
  expectedReads: number,
): { database: D1Database; started: string[] } => {
  const started: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const hold = async <T>(label: string, read: () => Promise<T>): Promise<T> => {
    started.push(label);
    if (started.length >= expectedReads) release();
    await barrier;
    return read();
  };
  const databaseBinding = {
    prepare: (sql: string) => {
      const statement = database.prepare(sql);
      const wrapped = {
        bind: (...values: Parameters<TestPreparedStatement["bind"]>) => {
          statement.bind(...values);
          return wrapped;
        },
        first: <T>() => {
          const label = identify(sql, "first");
          return label === null ? statement.first<T>() : hold(label, () => statement.first<T>());
        },
        all: <T>(...typeHint: readonly T[]) => {
          const label = identify(sql, "all");
          return label === null ? statement.all<T>(...typeHint) : hold(label, () => statement.all<T>(...typeHint));
        },
        run: () => statement.run(),
      };
      return wrapped;
    },
    batch: database.batch.bind(database),
  } as unknown as D1Database;
  return { database: databaseBinding, started };
};
