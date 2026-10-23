import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Loaded from node_modules at run time rather than bundled: PGlite finds its
  // WebAssembly and data files beside its own module, and pg has optional
  // native parts a bundler would try, and fail, to resolve.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // Content security policy, framing, HSTS and the rest (lib/security-headers.ts).
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};

export default nextConfig;
