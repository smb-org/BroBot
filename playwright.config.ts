import { defineConfig, devices } from "@playwright/test";

const playwrightPort = process.env.PLAYWRIGHT_PORT ?? "5174";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: `http://localhost:${playwrightPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `./node_modules/.bin/vite --host 127.0.0.1 --port ${playwrightPort} --strictPort`,
      url: `http://localhost:${playwrightPort}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // `wrangler dev` folgt der vom Vite-Plugin geschriebenen Umleitung
      // `.wrangler/deploy/config.json` auf `dist/brobot_local/wrangler.json`
      // und serviert `dist/brobot_local/index.js`, nicht `src/worker/index.ts`.
      // Deshalb muss vor dem E2E-Start ein Build laufen; `pretest:e2e` stellt
      // das bei `pnpm run test:e2e` sicher, ein direkter Playwright-Aufruf
      // setzt einen aktuellen Build voraus.
      command: "./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8787 --persist-to .wrangler/e2e-worker --show-interactive-dev-session=false",
      // Port statt Adresse: /healthz meldet bewusst 503, solange Secrets oder
      // Schema fehlen. Playwright wartet auf 2xx und liefe sonst in die
      // Zeitüberschreitung, obwohl der Worker längst antwortet.
      port: 8787,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { PUBLIC_ORIGIN: "http://127.0.0.1:8787" },
    },
  ],
  projects: [{ name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } }],
});
