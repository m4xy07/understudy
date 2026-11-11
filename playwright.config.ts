// End-to-end tests: the five-minute judge path in a real browser.
// Run against a local server (`pnpm dev`, then `pnpm test:e2e`) or the live app:
//   E2E_BASE_URL=https://understudy-lyart.vercel.app pnpm test:e2e
// Each run opens a fresh private copy of the demo workspace.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // One long journey; the leaver's answer re-tests the successor and can take about 20 s on the live app.
  timeout: 6 * 60_000,
  expect: { timeout: 20_000 },
  retries: 1,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
