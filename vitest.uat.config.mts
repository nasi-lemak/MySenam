import { defineConfig } from "vitest/config";

/**
 * Visual acceptance scenarios (tests/uat): several people at once, each in a
 * browser of their own, through the real pages, with video, a trace and a
 * screenshot of every step. Against the production build (`npm run build`
 * first) like the end-to-end tests, or a deployment (E2E_URL). See
 * docs/development/testing.md#visual-acceptance-scenarios.
 */
export default defineConfig({
  test: {
    include: ["tests/uat/**/*.uat.ts"],
    environment: "node",
    globalSetup: ["./tests/e2e/server.ts", "./tests/uat/setup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
