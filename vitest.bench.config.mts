import { defineConfig } from "vitest/config";
import path from "path";

/**
 * The marketplace benchmark (tests/bench/): not part of `npm test`. Run with
 * `BENCH_DATABASE_URL` naming a Postgres database it may fill and keep
 * (docs/development/testing.md#marketplace-benchmark).
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: {
    include: ["tests/bench/**/*.bench.ts"],
    environment: "node",
    env: { MYSENAM_GEOCODER: "off" },
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
