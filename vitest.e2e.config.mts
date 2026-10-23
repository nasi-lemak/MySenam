import { defineConfig } from "vitest/config";

/**
 * End-to-end tests: the production build (`npm run build` first) served by
 * `next start` on an in-memory database, driven by a real Chromium. See
 * tests/e2e/server.ts and docs/development/testing.md.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    environment: "node",
    globalSetup: ["./tests/e2e/server.ts"],
    // One server, one browser: the files share them, one after another.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
