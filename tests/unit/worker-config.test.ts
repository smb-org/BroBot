import { describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_MIGRATION,
  getPlatformUserIds,
  getHealthStatus,
  getMissingBindings,
} from "../../src/worker/config";

const keyRing = (byte: number): string => JSON.stringify({
  active: {
    id: `key-${String(byte)}`,
    key: Buffer.alloc(32, byte).toString("base64url"),
  },
  retired: [],
});

type SchemaState = {
  latestMigration: string | null;
  latestTableCount: number;
};

const schemaDatabase = (state: SchemaState = {
  latestMigration: LATEST_SCHEMA_MIGRATION,
  latestTableCount: 1,
}): D1Database => ({
  prepare: () => ({
    bind: () => ({
      first: () => Promise.resolve(state),
    }),
  }),
} as unknown as D1Database);

const environment = (
  pepper: string,
  overrides: Record<string, unknown> = {},
): Env => ({
  DB: schemaDatabase(),
  CHANNEL: {} as Env["CHANNEL"],
  ASSETS: {} as Env["ASSETS"],
  CF_VERSION_METADATA: { id: "version-test" } as Env["CF_VERSION_METADATA"],
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_EVENTSUB_SECRET: keyRing(3),
  PUBLIC_ORIGIN: "https://brobot.example",
  SESSION_COOKIE_KEYS: keyRing(1),
  SESSION_ENCRYPTION_KEYS: keyRing(2),
  OVERLAY_TOKEN_PEPPER: pepper,
  PLATFORM_USER_IDS: "[]",
  ...overrides,
} as Env);

describe("Health check binding validation", () => {
  it("reports a 31-byte overlay pepper as misconfigured", async () => {
    const health = await getHealthStatus(
      environment(Buffer.alloc(31, 4).toString("base64url")),
    );

    expect(health).toEqual({
      status: "misconfigured",
      missingBindings: ["OVERLAY_TOKEN_PEPPER"],
      statusCode: 503,
    });
  });

  it("accepts a canonical 32-byte overlay pepper", () => {
    const missingBindings = getMissingBindings(
      environment(Buffer.alloc(32, 4).toString("base64url")),
    );

    expect(missingBindings).toEqual([]);
  });

  it("accepts an empty operator array and reads valid ids as a set", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const env = environment(validPepper, {
      PLATFORM_USER_IDS: '["26876135", "42"]',
    });

    expect(getMissingBindings(env)).toEqual([]);
    expect([...getPlatformUserIds(env)]).toEqual(["26876135", "42"]);
    expect(getPlatformUserIds(environment(validPepper, { PLATFORM_USER_IDS: "[]" }))).toEqual(new Set());
    expect(getPlatformUserIds({})).toEqual(new Set());
  });

  /**
   * The rename ships before the secret is renamed in Cloudflare. Without the
   * fallback the deploy would lock everyone out of the platform level, and the
   * page where the secret is changed sits behind exactly that guard.
   */
  it("still reads the operator ids from the previous secret name", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const withOldName = environment(validPepper, {
      PLATFORM_USER_IDS: undefined,
      BETREIBER_USER_IDS: '["26876135"]',
    });

    expect([...getPlatformUserIds(withOldName)]).toEqual(["26876135"]);
    expect(getMissingBindings(withOldName)).toEqual([]);
  });

  it("prefers the current secret name when both are set", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const withBoth = environment(validPepper, {
      PLATFORM_USER_IDS: '["42"]',
      BETREIBER_USER_IDS: '["26876135"]',
    });

    expect([...getPlatformUserIds(withBoth)]).toEqual(["42"]);
  });

  it("reports an invalid operator secret and returns an empty set for it", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const env = environment(validPepper, { PLATFORM_USER_IDS: '["nicht-numerisch"]' });

    expect(getMissingBindings(env)).toContain("PLATFORM_USER_IDS");
    expect(getPlatformUserIds(env)).toEqual(new Set());
  });

  it("reports missing resource bindings and an invalid origin", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const missingBindings = getMissingBindings(environment(validPepper, {
      DB: undefined,
      PUBLIC_ORIGIN: "not-a-url",
    }));

    expect(missingBindings).toEqual(["DB", "PUBLIC_ORIGIN"]);
  });

  it("accepts an absolute origin without path or query", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    expect(getMissingBindings(environment(validPepper, {
      PUBLIC_ORIGIN: "http://localhost:5173",
    }))).toEqual([]);
  });

  it("reports an unapplied latest migration as a DB schema error", async () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const health = await getHealthStatus(environment(validPepper, {
      DB: schemaDatabase({
        latestMigration: "0003_overlay_tokens.sql",
        latestTableCount: 0,
      }),
    }));

    expect(health).toEqual({
      status: "misconfigured",
      missingBindings: ["DB_SCHEMA"],
      statusCode: 503,
    });
  });

  it("requires the sentinel table of the latest migration", async () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const health = await getHealthStatus(environment(validPepper, {
      DB: schemaDatabase({
        latestMigration: LATEST_SCHEMA_MIGRATION,
        latestTableCount: 0,
      }),
    }));

    expect(health.missingBindings).toEqual(["DB_SCHEMA"]);
  });
});
