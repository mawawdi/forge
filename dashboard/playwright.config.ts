import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level acceptance is deliberately local: all API responses are
 * intercepted by each spec, so it cannot call a provider or Studio.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
    },
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 1080 } },
    },
    {
      name: "tablet",
      use: { viewport: { width: 1024, height: 1000 } },
    },
    {
      name: "mobile",
      // Keep one engine for visual baselines; the device descriptor otherwise
      // selects WebKit, which is not part of this local Chromium-only suite.
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
