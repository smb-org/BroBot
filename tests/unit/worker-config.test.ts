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
  BETREIBER_USER_IDS: "[]",
  ...overrides,
} as Env);

describe("Healthcheck-Bindingvalidierung", () => {
  it("meldet einen 31-Byte-Overlay-Pepper als Fehlkonfiguration", async () => {
    const health = await getHealthStatus(
      environment(Buffer.alloc(31, 4).toString("base64url")),
    );

    expect(health).toEqual({
      status: "misconfigured",
      missingBindings: ["OVERLAY_TOKEN_PEPPER"],
      statusCode: 503,
    });
  });

  it("akzeptiert einen kanonischen 32-Byte-Overlay-Pepper", () => {
    const missingBindings = getMissingBindings(
      environment(Buffer.alloc(32, 4).toString("base64url")),
    );

    expect(missingBindings).toEqual([]);
  });

  it("akzeptiert ein leeres Betreiber-Array und liest gültige IDs als Set", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const env = environment(validPepper, {
      BETREIBER_USER_IDS: '["26876135", "42"]',
    });

    expect(getMissingBindings(env)).toEqual([]);
    expect([...getPlatformUserIds(env)]).toEqual(["26876135", "42"]);
    expect(getPlatformUserIds(environment(validPepper, { BETREIBER_USER_IDS: "[]" }))).toEqual(new Set());
    expect(getPlatformUserIds({})).toEqual(new Set());
  });

  it("meldet ein ungültiges Betreiber-Secret und liefert dafür ein leeres Set", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const env = environment(validPepper, { BETREIBER_USER_IDS: '["nicht-numerisch"]' });

    expect(getMissingBindings(env)).toContain("BETREIBER_USER_IDS");
    expect(getPlatformUserIds(env)).toEqual(new Set());
  });

  it("meldet fehlende Ressourcen-Bindings und eine ungültige Origin", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    const missingBindings = getMissingBindings(environment(validPepper, {
      DB: undefined,
      PUBLIC_ORIGIN: "not-a-url",
    }));

    expect(missingBindings).toEqual(["DB", "PUBLIC_ORIGIN"]);
  });

  it("akzeptiert eine absolute Origin ohne Pfad oder Query", () => {
    const validPepper = Buffer.alloc(32, 4).toString("base64url");
    expect(getMissingBindings(environment(validPepper, {
      PUBLIC_ORIGIN: "http://localhost:5173",
    }))).toEqual([]);
  });

  it("meldet eine nicht angewandte jüngste Migration als DB-Schemafehler", async () => {
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

  it("verlangt den Sentinel-Tisch der jüngsten Migration", async () => {
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
