import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded from node_modules at run time rather than bundled: PGlite finds its
  // WebAssembly and data files beside its own module, and pg has optional
  // native parts a bundler would try, and fail, to resolve.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default nextConfig;
