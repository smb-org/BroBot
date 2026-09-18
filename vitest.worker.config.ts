import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const testKey = (byte: number): string =>
  Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url");

const testKeyRing = (id: string, byte: number): string => JSON.stringify({
  active: { id, key: testKey(byte) },
  retired: [],
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TWITCH_CLIENT_ID: "local-twitch-client-id",
          TWITCH_CLIENT_SECRET: "test-twitch-client-secret",
          TWITCH_BOT_LOGIN: "brobot",
          TWITCH_EVENTSUB_SECRET: testKeyRing("test-eventsub", 3),
          PUBLIC_ORIGIN: "http://localhost:5173",
          SESSION_COOKIE_KEYS: testKeyRing("test-cookie", 1),
          SESSION_ENCRYPTION_KEYS: testKeyRing("test-encryption", 2),
          OVERLAY_TOKEN_PEPPER: testKey(4),
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    testTimeout: 30_000,
    inspector: { enabled: false },
  },
});
