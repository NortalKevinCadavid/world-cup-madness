import { defineConfig, devices } from "@playwright/test";

// Slice 009-ui-beautification broadens testDir from "./tests/playwright"
// to "./tests" so both pre-existing slice suites
// (tests/playwright/**) AND the new slice 009 suite
// (tests/e2e/009-ui-beautification/**) are picked up.
//
// Two new device projects are added for slice 009:
//   - iphone-se: 375x667, slow-3g + 4x CPU throttle profile
//   - desktop-1280: 1280x800, no throttle
// They are selectable with `playwright test --project=iphone-se`.

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    {
      name: "iphone-se",
      use: {
        ...devices["iPhone SE"],
        viewport: { width: 375, height: 667 },
      },
    },
    {
      name: "desktop-1280",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
