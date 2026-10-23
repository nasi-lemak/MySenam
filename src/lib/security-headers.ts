/**
 * Headers sent with every response (next.config.ts).
 *
 * The content security policy names where anything may come from: scripts,
 * styles and requests only from this site; images from here or any HTTPS
 * address (venue photos may sit in a bucket, maps come from OpenStreetMap);
 * no plugins; and no other site may frame a page, which stops a booking or
 * payment screen being dressed up inside someone else's.
 *
 * Inline scripts are still allowed: Next.js writes its page data inline, and
 * a per-request nonce instead would make every page render on request. So the
 * policy does not stop a script injected into a page; it stops one loaded
 * from elsewhere, and everything the other directives name.
 */
export function securityHeaders(dev = process.env.NODE_ENV !== "production"): { key: string; value: string }[] {
  const csp = [
    "default-src 'self'",
    // React in development evaluates code; production does not.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    // Older browsers that do not read frame-ancestors.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Where it is near: the only device feature the site asks for.
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
    // A year of HTTPS only. Browsers ignore it over plain HTTP, so a local
    // install is unaffected. Not for sub-domains: a storefront may be a
    // venue's own domain, whose other sites are not ours to bind. Not
    // preloaded: that is a choice for the owner.
    { key: "Strict-Transport-Security", value: "max-age=31536000" },
  ];
}
