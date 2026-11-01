import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    pool: "forks",
    testTimeout: 30_000,
    env: {
      PAYPAL_ENV: "sandbox",
      PAYPAL_MOCK: "1",
      ANTHROPIC_MOCK: "1",
      DATABASE_PATH: ":memory:",
      POLL_INTERVAL_MS: "600000",
      PAYPAL_WEBHOOK_ID: "WH-TEST-0000000000",
    },
  },
});