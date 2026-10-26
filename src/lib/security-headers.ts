/**
 * Headers sent with every response.
 *
 * The content security policy names where anything may come from: scripts
 * only those this response carries a fresh nonce for (and what they load),
 * styles and requests only from this site; images from here or any HTTPS
 * address (venue photos may sit in a bucket, maps come from OpenStreetMap);
 * no plugins; and no other site may frame a page, which stops a booking or
 * payment screen being dressed up inside someone else's.
 *
 * The nonce is made per request in the middleware (src/middleware.ts), which
 * sends the policy; Next.js puts it on its own scripts, as every page already
 * renders on request (the root layout reads the language cookie). A script
 * injected into a page has no nonce, so the browser will not run it.
 * `'unsafe-inline'` and `https:` stay only for browsers too old for nonces
 * and `'strict-dynamic'`, which ignore them otherwise. Inline styles are still
 * allowed: a style cannot run code.
 */
export function contentSecurityPolicy(nonce: string, dev = process.env.NODE_ENV !== "production"): string {
  return [
    "default-src 'self'",
    // React in development evaluates code; production does not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https:${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A nonce: 128 random bits, base64, from Web Crypto (the middleware runs at the edge). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** The rest, the same on every response (next.config.ts); the policy above comes from the middleware. */
export function securityHeaders(): { key: string; value: string }[] {
  return [
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

/**
 * The policy on a supporting document handed out by the app (an approval
 * application's PDF or image; lib/approval-documents.ts): nothing may load or
 * run, the document is sandboxed as if from another origin, and nothing may
 * frame it. A PDF is sent as an attachment besides, so the browser saves it
 * rather than opening it in this site's origin.
 */
export const DOCUMENT_POLICY = "default-src 'none'; img-src 'self'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Where those documents are served (the customer's, the dashboard's and a coach's link). */
export const DOCUMENT_PATH = /^\/api\/(my\/approvals|admin\/approvals|my\/reviews)\/document$/;
