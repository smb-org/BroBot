export interface MessageEnabledField {
  messagePath: string;
  enabledPath: string;
}

const readPath = (value: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>(
  (current, key) => typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined,
  value,
);

const writePath = (value: Record<string, unknown>, path: string, nextValue: unknown): Record<string, unknown> => {
  const [key, ...rest] = path.split(".");
  if (key === undefined) return value;
  const current = value[key];
  return {
    ...value,
    [key]: rest.length === 0
      ? nextValue
      : writePath(typeof current === "object" && current !== null && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {}, rest.join("."), nextValue),
  };
};

/** Freezes legacy text-derived switch defaults when a settings draft is created. */
export const resolveMessageEnabledFlags = <Settings extends object>(
  settings: Settings,
  fields: readonly MessageEnabledField[],
): Settings => fields.reduce<Record<string, unknown>>((resolved, { messagePath, enabledPath }) => {
  const message = readPath(resolved, messagePath);
  const explicit = readPath(resolved, enabledPath);
  if (Array.isArray(message)) {
    const flags = message.map((text, index) => {
      const currentFlag: unknown = Array.isArray(explicit) ? (explicit as unknown[])[index] : undefined;
      return typeof currentFlag === "boolean" ? currentFlag : typeof text === "string" && text.trim().length > 0;
    });
    return writePath(resolved, enabledPath, flags);
  }
  if (typeof message === "string" && typeof explicit !== "boolean") {
    return writePath(resolved, enabledPath, message.trim().length > 0);
  }
  return resolved;
}, settings as Record<string, unknown>) as Settings;
