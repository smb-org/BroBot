import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const placeholderKey = (fill: string): string => `test-${fill.repeat(40)}`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TWITCH_CLIENT_ID: "local-twitch-client-id",
          TWITCH_CLIENT_SECRET: "test-twitch-client-secret",
          TWITCH_EVENTSUB_SECRET: "test-twitch-eventsub-secret",
          PUBLIC_ORIGIN: "http://localhost:5173",
          SESSION_COOKIE_KEYS: JSON.stringify({
            active: { id: "test-cookie", key: placeholderKey("A") },
          }),
          SESSION_ENCRYPTION_KEYS: JSON.stringify({
            active: { id: "test-encryption", key: placeholderKey("B") },
          }),
          OVERLAY_TOKEN_PEPPER: placeholderKey("C"),
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
