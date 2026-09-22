import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrationsDirectory = resolve(import.meta.dirname, "../migrations");

const migrationFiles = () => readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const migrationError = (fileName, error) => {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Migration ${fileName} fehlgeschlagen: ${message}`, { cause: error });
};

const statementWithTerminator = (sql) => {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
};

export const generateBaseline = () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const fileName of migrationFiles()) {
      try {
        database.exec(readFileSync(resolve(migrationsDirectory, fileName), "utf8"));
      } catch (error) {
        throw migrationError(fileName, error);
      }
    }
    const objects = database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY tbl_name, type DESC, name",
    ).all();
    return objects.map((object) => statementWithTerminator(object.sql)).join("\n\n");
  } finally {
    database.close();
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.stdout.write(generateBaseline());
    process.stdout.write("\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
