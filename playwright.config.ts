import { defineConfig, devices } from "@playwright/test";
import { e2eWorkerEnvironment, e2eWorkerPort } from "./tests/e2e/worker-fixtures";

const playwrightPort = process.env.PLAYWRIGHT_PORT ?? "5174";
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const workerBindings = Object.entries(e2eWorkerEnvironment)
  .map(([name, value]) => `--var ${shellQuote(`${name}:${value}`)}`)
  .join(" ");

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
      // Run from the built output so Wrangler serves index.js and resolves
      // assets and migrations relative to dist/brobot_local. A build is
      // required; `pretest:e2e` supplies it for pnpm run test:e2e.
      command: `./node_modules/.bin/wrangler --cwd dist/brobot_local --config wrangler.json dev --local --ip 127.0.0.1 --port ${e2eWorkerPort} --persist-to ../../.wrangler/e2e-worker --show-interactive-dev-session=false ${workerBindings}`,
      // Port statt Adresse: /healthz meldet bewusst 503, solange Secrets oder
      // Schema fehlen. Playwright wartet auf 2xx und liefe sonst in die
      // Zeitüberschreitung, obwohl der Worker längst antwortet.
      port: Number(e2eWorkerPort),
      reuseExistingServer: false,
      timeout: 120_000,
      env: e2eWorkerEnvironment,
    },
  ],
  projects: [{ name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } }],
});
