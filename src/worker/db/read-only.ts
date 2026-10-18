export class DryRunWriteError extends Error {
  public constructor(message = "Dry-run attempted to write through its read-only database capability.") {
    super(message);
    this.name = "DryRunWriteError";
  }
}

const removeLeadingSqlComments = (sql: string): string | null => {
  let remaining = sql;
  for (;;) {
    const trimmed = remaining.trimStart();
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n");
      if (newline < 0) return "";
      remaining = trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const closing = trimmed.indexOf("*/", 2);
      if (closing < 0) return null;
      remaining = trimmed.slice(closing + 2);
      continue;
    }
    return trimmed;
  }
};

const isReadStatement = (sql: string): boolean => {
  const statement = removeLeadingSqlComments(sql);
  return statement !== null && /^SELECT\b/iu.test(statement);
};

/** Provides D1 read methods while rejecting write-capable SQL at prepare time. */
export const readOnlyD1 = (database: D1Database): D1Database => {
  const wrappedStatements = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(statementTarget, statementProperty) {
        const method: unknown = Reflect.get(statementTarget, statementProperty, statementTarget);
        if (statementProperty === "bind" && typeof method === "function") {
          return (...parameters: unknown[]): D1PreparedStatement =>
            wrapStatement(Reflect.apply(method, statementTarget, parameters) as D1PreparedStatement);
        }
        return typeof method === "function"
          ? (...parameters: unknown[]): unknown => Reflect.apply(method, statementTarget, parameters)
          : method;
      },
    });
    wrappedStatements.set(wrapped, statement);
    return wrapped;
  };
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "prepare" && typeof value === "function") {
        return (sql: string): D1PreparedStatement => {
          if (!isReadStatement(sql)) throw new DryRunWriteError(`Dry-run rejected non-SELECT SQL: ${sql.slice(0, 80)}`);
          const statement = Reflect.apply(value, target, [sql]) as D1PreparedStatement;
          return wrapStatement(statement);
        };
      }
      if (property === "batch" && typeof value === "function") {
        return (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
          const unwrappedStatements = statements.map((statement) => wrappedStatements.get(statement));
          if (unwrappedStatements.some((statement) => statement === undefined)) {
            throw new DryRunWriteError("Dry-run rejected a batch containing a statement from outside its read-only database capability.");
          }
          return Reflect.apply(value, target, [unwrappedStatements as D1PreparedStatement[]]) as Promise<D1Result[]>;
        };
      }
      if (property === "exec" || property === "dump") {
        return (): never => { throw new DryRunWriteError(`Dry-run rejected D1Database.${property}().`); };
      }
      if (property === "withSession" && typeof value === "function") {
        return (...parameters: unknown[]) => readOnlyD1(Reflect.apply(value, target, parameters) as D1Database);
      }
      return typeof value === "function"
        ? (...parameters: unknown[]): unknown => Reflect.apply(value, target, parameters)
        : value;
    },
  });
};
