import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  // tsconfig says jsx: "preserve", because Next does its own transform. The
  // test runner has no Next, so it brings its own.
  plugins: [react()],
  resolve: {
    // Route handlers import through the same alias the app uses, so the tests
    // have to resolve it too — otherwise the authorisation checks can only be
    // exercised by hand against a running server, which is where they were.
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    // The default is node, because most of the suite drives a real SQLite
    // database. A component test opts into a browser with a
    // `// @vitest-environment jsdom` line at the top of the file, so the two
    // kinds live side by side without the DB tests paying for a DOM.
    environment: "node",
    setupFiles: ["./tests/setup-dom.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "html"],
      // The application's own code. Config, scripts and the pages themselves
      // are left out: a page is a layout, and a number for it would say more
      // about how much markup it has than about what is tested.
      include: ["src/lib/**/*.ts", "src/components/**/*.tsx", "src/app/api/**/*.ts"],
      exclude: ["src/lib/db.ts"],
      /**
       * A floor, not a target.
       *
       * The business rules are held high, because that is where being wrong
       * costs a venue money or a customer their court. The whole-project
       * numbers are deliberately lower: seven admin tabs are still untested,
       * and a threshold set above what is true would either be a lie or would
       * push somebody into writing tests that only move a number.
       */
      thresholds: {
        statements: 55,
        branches: 45,
        functions: 57,
        lines: 55,
        "src/lib/**/*.ts": {
          statements: 90,
          branches: 83,
          functions: 95,
          lines: 94,
        },
      },
    },
  },
});
