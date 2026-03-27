import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "*.pw.mjs",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    browserName: "chromium",
  },
  webServer: {
    command: "npx vite --port 5173",
    port: 5173,
    reuseExistingServer: true,
  },
});
