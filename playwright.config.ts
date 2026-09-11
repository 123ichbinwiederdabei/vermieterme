import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: { baseURL: "http://127.0.0.1:3210", trace: "retain-on-failure", screenshot: "only-on-failure" },
  globalSetup: "./e2e/global-setup.ts",
  webServer: {
    command: "node e2e/server.mjs",
    url: "http://127.0.0.1:3210/api/auth/session",
    reuseExistingServer: false,
    timeout: 300_000,
    env: { DATABASE_URL: "file:./e2e.db", AUTH_SECRET: "e2e-secret-at-least-32-characters-long", AUTH_TRUST_HOST: "true", ADMIN_EMAIL: "e2e@example.test", ADMIN_PASSWORD: "e2e-password" },
  },
  // The Windows development host has Chrome installed, while CI installs the
  // Playwright-managed Chromium binary.  Do not pin CI to a system browser.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.platform === "win32" ? { channel: "chrome" } : {}) } }],
});
