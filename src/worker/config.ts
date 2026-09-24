import { isBase64url32Byte, parseKeyRing } from "./auth/crypto";

export const REQUIRED_SECRET_NAMES = [
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "PUBLIC_ORIGIN",
  "SESSION_COOKIE_KEYS",
  "TOKEN_ENCRYPTION_KEYS",
  "OVERLAY_TOKEN_PEPPER",
  "PLATFORM_USER_IDS",
] as const;

// Wrangler tracks the applied filenames in d1_migrations. This means the
// full table-to-migration list never needs duplicating; only the current
// release sentinel changes when a new migration is added.
//
// Manually keeping the constant in sync is where this breaks: forget to
// update it and /healthz reports a freshly set-up database as broken (503)
// even though everything is fine. `tests/unit/schema-baseline.test.ts`
// therefore pins it to the last file in `migrations/`.
export const LATEST_SCHEMA_MIGRATION = "0012_overlays.sql";
export const LATEST_SCHEMA_TABLE = "overlays";

const REQUIRED_BINDING_NAMES = ["DB", "CHANNEL", "ASSETS", "CF_VERSION_METADATA"] as const;

const KEY_RING_SECRET_NAMES = new Set([
  "TWITCH_EVENTSUB_SECRET",
  "SESSION_COOKIE_KEYS",
  "TOKEN_ENCRYPTION_KEYS",
]);
const PLACEHOLDER_PATTERN = /replace-with|example\.invalid/i;
const PLATFORM_USER_ID_PATTERN = /^\d+$/;

const secretValue = (env: Env, name: string): unknown => {
  const value: unknown = Reflect.get(env, name);
  if (name === "TOKEN_ENCRYPTION_KEYS" && (value === undefined || value === null || value === "")) {
    return Reflect.get(env, "SESSION_ENCRYPTION_KEYS");
  }
  // The rename ships before the secret is set, so the old name keeps working.
  // Without this the deploy would lock everyone out of the platform level --
  // including the page where the secret is changed.
  if (name === "PLATFORM_USER_IDS" && (value === undefined || value === null || value === "")) {
    return Reflect.get(env, "BETREIBER_USER_IDS");
  }
  return value;
};

const parsePlatformUserIds = (value: unknown): string[] | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(
      (userId): userId is string => typeof userId === "string" && PLATFORM_USER_ID_PATTERN.test(userId),
    ) ? parsed : null;
  } catch {
    return null;
  }
};

export const getPlatformUserIds = (
  env: { readonly PLATFORM_USER_IDS?: unknown; readonly BETREIBER_USER_IDS?: unknown },
): ReadonlySet<string> => {
  const parsed = parsePlatformUserIds(secretValue(env as unknown as Env, "PLATFORM_USER_IDS"));
  return parsed === null ? new Set<string>() : new Set(parsed);
};

const isAbsoluteOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

export const getMissingBindings = (env: Env): string[] => [
  ...REQUIRED_BINDING_NAMES.filter((name) => {
    const value: unknown = Reflect.get(env, name);
    return value === undefined || value === null;
  }),
  ...REQUIRED_SECRET_NAMES.filter((name) => {
    const value = secretValue(env, name);
    if (typeof value !== "string" || value.length === 0 || PLACEHOLDER_PATTERN.test(value)) return true;
    if (name === "PUBLIC_ORIGIN") return !isAbsoluteOrigin(value);
    if (name === "OVERLAY_TOKEN_PEPPER") return !isBase64url32Byte(value);
    if (name === "PLATFORM_USER_IDS") return parsePlatformUserIds(value) === null;
    if (!KEY_RING_SECRET_NAMES.has(name)) return false;
    try {
      parseKeyRing(value);
      return false;
    } catch {
      return true;
    }
  }),
];

const getMissingSchema = async (env: Env): Promise<string[]> => {
  try {
    const schema = await env.DB.prepare(`
      SELECT
        (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS latest_migration,
        (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name = ?) AS latest_table_count
    `).bind(LATEST_SCHEMA_TABLE).first<{
      latest_migration: string | null;
      latest_table_count: number;
    }>();

    if (
      schema?.latest_migration === LATEST_SCHEMA_MIGRATION &&
      schema.latest_table_count > 0
    ) return [];
  } catch {
    // A missing migration table or unreachable D1 counts as a schema error.
  }

  return ["DB_SCHEMA"];
};

export const getHealthStatus = async (env: Env): Promise<{
  status: "ok" | "misconfigured";
  missingBindings: string[];
  statusCode: 200 | 503;
}> => {
  const missingBindings = getMissingBindings(env);
  if (missingBindings.length > 0) {
    return {
      status: "misconfigured",
      missingBindings,
      statusCode: 503,
    };
  }

  const schemaErrors = await getMissingSchema(env);
  const allErrors = [...missingBindings, ...schemaErrors];
  return {
    status: allErrors.length === 0 ? "ok" : "misconfigured",
    missingBindings: allErrors,
    statusCode: allErrors.length === 0 ? 200 : 503,
  };
};
