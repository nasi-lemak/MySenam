import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    // Route handlers import through the same alias the app uses, so the tests
    // have to resolve it too — otherwise the authorisation checks can only be
    // exercised by hand against a running server, which is where they were.
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
