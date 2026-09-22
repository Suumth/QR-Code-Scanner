import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";
const serverManagedByRunner = process.env.RT22_E2E_SERVER_MANAGED === "true";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: "line",
  outputDir: "test-results",
  use: {
    baseURL,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  ...(serverManagedByRunner
    ? {}
    : {
        webServer: {
          command: "node scripts/e2e-server.mjs",
          gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
          url: `${baseURL}/api/health`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
});
