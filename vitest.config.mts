import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    setupFiles: ["./scripts/load-env.ts"],
    // Tests never call the live model: callJson answers from the cache or fails fast, and the
    // Lacuna stand-in uses its deterministic reading. Tests that need model answers inject a fake call.
    env: { MODEL_DISABLED: "1", LACUNA_MODEL: "off" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
