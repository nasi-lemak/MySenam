/**
 * A cross-site request forgery check for the app's own routes.
 *
 * A browser sends its cookies with a request another site makes it send.
 * SameSite=Lax already keeps them off cross-site POSTs in current browsers;
 * this is the second line: a request that changes something, carries one of
 * our sign-in cookies, and says it comes from another site (Origin, or
 * Sec-Fetch-Site) is refused.
 *
 * Only requests carrying a sign-in cookie are checked, so the gateways'
 * callbacks and WhatsApp's webhook (servers, with no cookies) are untouched,
 * as is the public API, which is authorised by its key.
 */

const SIGN_IN_COOKIES = ["ms_session", "ms_admin"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RequestFacts {
  method: string;
  pathname: string;
  /** Header values by lower-case name. */
  header: (name: string) => string | null;
  cookieNames: string[];
}

/** The hosts this request may legitimately come from: its own, and the configured site. */
function ownHosts(req: RequestFacts): Set<string> {
  const hosts = new Set<string>();
  for (const value of [req.header("host"), req.header("x-forwarded-host")])
    for (const host of (value ?? "").split(",")) if (host.trim()) hosts.add(host.trim().toLowerCase());
  const site = process.env.MYSENAM_URL;
  if (site) {
    try {
      hosts.add(new URL(site).host.toLowerCase());
    } catch {
      // A malformed MYSENAM_URL is reported at startup, not here.
    }
  }
  return hosts;
}

/** Why the request is refused, or null when it may go on. */
export function crossSiteRefusal(req: RequestFacts): string | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  if (!req.pathname.startsWith("/api/") || req.pathname.startsWith("/api/v1/")) return null;
  if (!req.cookieNames.some((c) => SIGN_IN_COOKIES.includes(c))) return null;

  if (req.header("sec-fetch-site") === "cross-site") return "cross-site";
  const origin = req.header("origin");
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return "bad origin";
  }
  return ownHosts(req).has(host) ? null : "foreign origin";
}
