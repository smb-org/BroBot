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
  const capability = (methods: Readonly<Record<string, unknown>>): object => new Proxy(Object.create(null) as object, {
    get(_target, property) {
      return typeof property === "string" && Object.hasOwn(methods, property) ? methods[property] : undefined;
    },
    getPrototypeOf: () => null,
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
  });
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const methods: Record<string, unknown> = {};
    for (const property of ["first", "all", "raw"] as const) {
      const method: unknown = Reflect.get(statement, property, statement);
      if (typeof method === "function") {
        methods[property] = (...parameters: unknown[]): unknown => Reflect.apply(method, statement, parameters) as unknown;
      }
    }
    const bind: unknown = Reflect.get(statement, "bind", statement);
    if (typeof bind === "function") {
      methods.bind = (...parameters: unknown[]): D1PreparedStatement =>
        wrapStatement(Reflect.apply(bind, statement, parameters) as D1PreparedStatement);
    }
    return capability(methods) as D1PreparedStatement;
  };
  const prepare = database.prepare.bind(database);
  return capability({
    prepare: (sql: string): D1PreparedStatement => {
      if (!isReadStatement(sql)) throw new DryRunWriteError(`Dry-run rejected non-SELECT SQL: ${sql.slice(0, 80)}`);
      return wrapStatement(prepare(sql));
    },
  }) as D1Database;
};
