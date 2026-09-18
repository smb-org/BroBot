import { describe, expect, it } from "vitest";

import { getHealthStatus, getMissingBindings } from "../../src/worker/config";

const keyRing = (byte: number): string => JSON.stringify({
  active: {
    id: `key-${String(byte)}`,
    key: Buffer.alloc(32, byte).toString("base64url"),
  },
  retired: [],
});

const environment = (pepper: string): Env => ({
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_EVENTSUB_SECRET: keyRing(3),
  PUBLIC_ORIGIN: "https://brobot.example",
  SESSION_COOKIE_KEYS: keyRing(1),
  SESSION_ENCRYPTION_KEYS: keyRing(2),
  OVERLAY_TOKEN_PEPPER: pepper,
} as Env);

describe("Healthcheck-Bindingvalidierung", () => {
  it("meldet einen 31-Byte-Overlay-Pepper als Fehlkonfiguration", () => {
    const health = getHealthStatus(
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
});
