import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  timeout: 30_000,
  retries: 0,
  reporter: "list",
  outputDir: "./artifacts/dashboard-browser",
  use: { baseURL: "http://127.0.0.1:5175", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js --config src/dashboard/web/vite.config.ts --port 5175 --strictPort",
    cwd: ".",
    url: "http://127.0.0.1:5175",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
