import { NextRequest, NextResponse } from "next/server";
import { crossSiteRefusal } from "./lib/same-origin";
import { contentSecurityPolicy, DOCUMENT_PATH, DOCUMENT_POLICY, newNonce } from "./lib/security-headers";
import { LINK_LOCALE_HEADER, linkLocaleOf } from "./lib/link-locale";

/**
 * Every request but static files: a fresh nonce and the content security
 * policy naming it (lib/security-headers.ts), handed to Next.js on the
 * request so it puts the nonce on its scripts, and sent with the response.
 * A signed-in change asked for by another site is refused (lib/same-origin.ts).
 */
export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const refusal = crossSiteRefusal({
      method: req.method,
      pathname: req.nextUrl.pathname,
      header: (name) => req.headers.get(name),
      cookieNames: req.cookies.getAll().map((c) => c.name),
    });
    if (refusal) return withPolicy(NextResponse.json({ error: "That request came from another site, so it was refused." }, { status: 403 }), contentSecurityPolicy(newNonce()));
  }
  // A supporting document gets the document policy, never the pages' one (lib/security-headers.ts).
  const policy = DOCUMENT_PATH.test(req.nextUrl.pathname) ? DOCUMENT_POLICY : contentSecurityPolicy(newNonce());
  const headers = new Headers(req.headers);
  headers.set("Content-Security-Policy", policy);
  // A message's link opens in the message's language, unless one was chosen (lib/link-locale.ts): only one of the four, never what the browser sent.
  headers.delete(LINK_LOCALE_HEADER);
  const linked = linkLocaleOf(req.nextUrl.searchParams);
  if (linked) headers.set(LINK_LOCALE_HEADER, linked);
  return withPolicy(NextResponse.next({ request: { headers } }), policy);
}

function withPolicy(res: NextResponse, policy: string): NextResponse {
  res.headers.set("Content-Security-Policy", policy);
  return res;
}

// Not Next.js's own built files and images, nor files served as they are.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt|xml)$).*)"] };
